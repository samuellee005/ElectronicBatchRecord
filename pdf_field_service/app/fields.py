"""Stages B–D — field emission, label association, type classification.

This module consumes the geometry from Stage A (`geometry.PageGeometry`)
and produces a list of `Suggestion` records ready to ship in the /detect
response.

The contract that fixes the "multiple inputs in one horizontal cell" bug:
    For every input-cell we emit **exactly one** Suggestion. Interior
    horizontal rules inside a cell are decoration and do NOT spawn extra
    fields. This is enforced structurally — we iterate cells, not rules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .geometry import Cell, HLine, PageGeometry, Rect, Table


# ---------- Output record ------------------------------------------------ #


@dataclass
class Suggestion:
    page: int
    kind: str
    field_type: str
    x: float
    y: float
    width: float
    height: float
    label_text: str
    confidence: float
    # Provenance: lets the frontend opt out of min-size clamps for from-cell
    # fields and surfaces table layout in debug overlays.
    from_cell: bool = False
    table_id: int | None = None
    cell_row: int | None = None
    cell_col: int | None = None
    label_confidence: float = 0.0
    # Split label parts so the form builder can show the column header as
    # the field's display label while keeping the row identifier around
    # for grouping / batch context.
    row_id: str = ""
    col_header: str = ""


# ---------- Helpers ------------------------------------------------------ #


_UNDERSCORE_RE = re.compile(r"[_\s–—\-./\\=]+")


def _is_underscore_filler(t: str) -> bool:
    """Placeholder text used to indicate an underline (e.g. ``______``).

    These tokens look like words but aren't meaningful labels — we skip
    them when measuring whether a cell contains text.
    """
    s = (t or "").strip()
    if len(s) < 3:
        return False
    if _UNDERSCORE_RE.fullmatch(s):
        return True
    alnum = re.sub(r"[^A-Za-z0-9]", "", s)
    if not alnum and len(s) >= 4:
        return True
    if len(alnum) <= 1 and s.count("_") >= 4:
        return True
    return False


def _words_in(
    words: list[tuple[float, float, float, float, str]],
    rect: Rect,
    inset: float = 0.0,
) -> list[tuple[float, float, float, float, str]]:
    """Words whose centre point falls inside `rect` (minus an inset)."""
    x0 = rect.x + inset
    y0 = rect.y + inset
    x1 = rect.x1 - inset
    y1 = rect.y1 - inset
    out = []
    for wx0, wy0, wx1, wy1, t in words:
        cx = (wx0 + wx1) / 2
        cy = (wy0 + wy1) / 2
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            out.append((wx0, wy0, wx1, wy1, t))
    return out


def _cell_text(
    cell: Cell,
    words: list[tuple[float, float, float, float, str]],
) -> str:
    """Concatenated, left-to-right text inside a cell (ignoring fillers)."""
    parts = []
    for wx0, wy0, wx1, wy1, t in _words_in(words, cell.bbox, inset=0.5):
        if _is_underscore_filler(t):
            continue
        parts.append((wx0, t.strip()))
    parts.sort(key=lambda p: p[0])
    return " ".join(p[1] for p in parts if p[1]).strip()


def _label_has_data(label: str) -> bool:
    if not label:
        return False
    alnum = re.findall(r"[A-Za-z0-9]", label)
    return len(alnum) >= 2


_CHECKBOX_TOKEN_RE = re.compile(
    r"\b(yes|no|y/n|y|n|pass|fail|n/a)\b", re.IGNORECASE,
)
_CHECKBOX_GLYPH_CHARS = set("☐□✓✔☑☑☒")


def _is_checkbox_prompt(text: str) -> bool:
    """Detect cells whose value is a Yes/No-style prompt.

    Examples that should match:
        "Yes No", "Yes / No", "I Yes I No", "☐ Yes ☐ No",
        "Pass / Fail", "Y/N"
    """
    if not text:
        return False
    t = text.strip()
    # Replace single-letter "I" tokens and checkbox glyphs with spaces so
    # the remaining alphanumeric content is just the yes/no words.
    cleaned = re.sub(r"\b[Ii]\b", " ", t)
    for ch in _CHECKBOX_GLYPH_CHARS:
        cleaned = cleaned.replace(ch, " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return False
    # Must be short — long sentences containing "yes" are not prompts.
    word_count = len(re.findall(r"[A-Za-z]+", cleaned))
    if word_count > 4:
        return False
    if not _CHECKBOX_TOKEN_RE.search(cleaned):
        return False
    return True


# ---------- Stage B: cell classification + emission ---------------------- #


def _cell_role(
    text: str,
    words_in_cell: list[tuple[float, float, float, float, str]],
) -> str:
    """Classify a cell's content for emission.

    Returns one of:
        "empty"     — no meaningful content; emit an input
        "checkbox"  — Yes/No-style prompt; emit a checkbox input
        "label"     — any other text content; skip (label/data, no input)
    """
    if not text:
        return "empty"
    if _is_checkbox_prompt(text):
        return "checkbox"
    # Count alnum chars across non-filler words.
    alnum_total = 0
    for _, _, _, _, t in words_in_cell:
        if _is_underscore_filler(t):
            continue
        alnum_total += sum(1 for ch in t if ch.isalnum())
    return "label" if alnum_total >= 1 else "empty"


def _is_label_cell(
    cell: Cell,
    text: str,
    words_in_cell: list[tuple[float, float, float, float, str]],
) -> bool:
    """Back-compat shim retained for tests."""
    return _cell_role(text, words_in_cell) == "label"


def _emit_from_cell(
    cell: Cell,
    label: str,
    row_id: str,
    col_header: str,
    label_conf: float,
    field_type: str,
    page_num: int,
    kind: str = "cell_input",
    inset: float = 0.0,
) -> Suggestion:
    """Emit ONE suggestion bound to the cell rect.

    By default we use the cell rect verbatim (inset=0) so the form
    builder's outline sits exactly on the underlying PDF cell border.
    """
    bx = cell.bbox.x + inset
    by = cell.bbox.y + inset
    bw = max(8.0, cell.bbox.w - 2 * inset)
    bh = max(8.0, cell.bbox.h - 2 * inset)
    return Suggestion(
        page=page_num,
        kind=kind,
        field_type=field_type,
        x=bx,
        y=by,
        width=bw,
        height=bh,
        label_text=label,
        confidence=0.78 if label_conf >= 0.6 else 0.62,
        from_cell=True,
        table_id=cell.table_id,
        cell_row=cell.row,
        cell_col=cell.col,
        label_confidence=label_conf,
        row_id=row_id,
        col_header=col_header,
    )


def _emit_from_underline(
    line: HLine,
    label: str,
    label_conf: float,
    field_type: str,
    page_num: int,
    page_h: float,
) -> Suggestion:
    """One suggestion sized to a standalone underline (text sits above it)."""
    field_w = max(40.0, line.x1 - line.x0)
    # Height: ~1.4 × typical body text. Cap so we don't smother labels.
    field_h = min(max(18.0, page_h * 0.027), 32.0)
    field_x = max(0.0, line.x0)
    field_y = max(0.0, line.y - field_h - 2.0)
    return Suggestion(
        page=page_num,
        kind="standalone_underline",
        field_type=field_type,
        x=field_x,
        y=field_y,
        width=field_w,
        height=field_h,
        label_text=label,
        confidence=0.6 if label_conf >= 0.6 else 0.5,
        from_cell=False,
        label_confidence=label_conf,
    )


def _emit_from_box(
    rect: Rect,
    label: str,
    label_conf: float,
    field_type: str,
    page_num: int,
) -> Suggestion:
    return Suggestion(
        page=page_num,
        kind="standalone_box",
        field_type=field_type,
        x=rect.x + 1.0,
        y=rect.y + 1.0,
        width=max(12.0, rect.w - 2.0),
        height=max(12.0, rect.h - 2.0),
        label_text=label,
        confidence=0.6 if label_conf >= 0.6 else 0.5,
        from_cell=False,
        label_confidence=label_conf,
    )


def _emit_checkbox(rect: Rect, label: str, label_conf: float, page_num: int) -> Suggestion:
    return Suggestion(
        page=page_num,
        kind="checkbox",
        field_type="checkbox",
        x=rect.x,
        y=rect.y,
        width=rect.w,
        height=rect.h,
        label_text=label,
        confidence=0.5 if label_conf >= 0.6 else 0.42,
        from_cell=False,
        label_confidence=label_conf,
    )


# ---------- Stage C: label association ----------------------------------- #


def _find_label_parts_for_cell(
    cell: Cell,
    table: Table,
    cell_texts: dict[tuple[int, int], str],
    injected_col_headers: dict[int, str] | None = None,
) -> tuple[str, str, float]:
    """Find (row_id, col_header, confidence) for a cell.

    - row_id: leftmost labelled cell in the same row (typically col 0).
              Empty when no cell to the left has text.
    - col_header: nearest labelled cell above in the same column, or one
                  injected from a previous page's matching table. We only
                  trust this when the column has a clear header row — for
                  pure 2-col label|value layouts the search is skipped to
                  avoid pulling unrelated text into the label.
    """
    row, col = cell.row, cell.col
    num_cols = len(table.col_bounds) - 1

    row_id = ""
    for c in range(0, col):
        txt = cell_texts.get((row, c), "")
        if _label_has_data(txt):
            row_id = _clean_label(txt)
            break
    if not row_id:
        for c in range(col - 1, -1, -1):
            txt = cell_texts.get((row, c), "")
            if _label_has_data(txt):
                row_id = _clean_label(txt)
                break

    col_header = ""
    if num_cols >= 3:
        # Walk upward, accept a row as our column header only when (a) it
        # has text in our specific column AND (b) at least half its cells
        # carry text overall (filters stray data rows like
        # "Approved : I Yes I No" or "Ingredient A | 25 kg | _ | _").
        for r in range(row - 1, -1, -1):
            cand = cell_texts.get((r, col), "")
            if not _label_has_data(cand):
                continue
            cells_in_row = [
                cell_texts.get((r, cc), "") for cc in range(num_cols)
            ]
            text_count = sum(1 for t in cells_in_row if _label_has_data(t))
            if text_count >= max(2, num_cols // 2):
                col_header = _clean_label(cand)
                break
        # Inject headers from an upstream (previous page) matching table.
        if not col_header and injected_col_headers:
            inj = injected_col_headers.get(col)
            if _label_has_data(inj or ""):
                col_header = _clean_label(inj or "")

    has_row = bool(row_id)
    has_col = bool(col_header)
    if has_row and has_col:
        conf = 0.9
    elif has_row or has_col:
        conf = 0.75
    else:
        conf = 0.0
    return row_id, col_header, conf


def _compose_display_label(row_id: str, col_header: str, num_cols: int) -> str:
    """Choose the visible label: row_id for 2-col, col_header for grids."""
    if num_cols <= 2:
        return row_id or col_header
    # Grid table: prefer column header.
    return col_header or row_id


def _header_row_words_by_col(
    table: Table,
    words: list[tuple[float, float, float, float, str]],
) -> dict[int, str]:
    """Bucket words inside the table's first row band by column x-position.

    When the table's row 0 has no internal column dividers (a single
    merged header cell), `_cell_text` returns all the column headers as
    one blob in cell (0, 0). We re-bucket the same words by their
    x-center against `col_bounds` so each column gets its proper header.
    """
    out: dict[int, str] = {}
    num_cols = len(table.col_bounds) - 1
    if num_cols < 1 or len(table.row_bounds) < 2:
        return out
    y_top = table.row_bounds[0]
    y_bot = table.row_bounds[1]
    per_col: dict[int, list[tuple[float, str]]] = {c: [] for c in range(num_cols)}
    for wx0, wy0, wx1, wy1, t in words:
        cy = (wy0 + wy1) / 2
        if not (y_top - 1 <= cy <= y_bot + 1):
            continue
        cx = (wx0 + wx1) / 2
        for c in range(num_cols):
            if table.col_bounds[c] <= cx <= table.col_bounds[c + 1]:
                per_col[c].append((wx0, t.strip()))
                break
    for c, parts in per_col.items():
        if not parts:
            continue
        parts.sort(key=lambda p: p[0])
        out[c] = " ".join(p[1] for p in parts).strip()
    return out


def _column_headers_from_text_above(
    table: Table,
    words: list[tuple[float, float, float, float, str]],
    search_height: float = 40.0,
) -> dict[int, str]:
    """Infer per-column header text from text just above a table.

    Strategy:
      1. Collect words in a band above the table top.
      2. Cluster into text "lines" by baseline (y) proximity.
      3. Keep only the two text lines nearest the table (typical column
         headers wrap across at most two lines).
      4. Bucket each word into a column by x-center.
    """
    out: dict[int, str] = {}
    num_cols = len(table.col_bounds) - 1
    if num_cols < 1:
        return out
    y_top = table.bbox.y
    band_top = max(0.0, y_top - search_height)

    band_words: list[tuple[float, float, float, float, str]] = []
    for wx0, wy0, wx1, wy1, t in words:
        cy = (wy0 + wy1) / 2
        if band_top <= cy <= y_top:
            band_words.append((wy0, wy1, wx0, wx1, t.strip()))
    if not band_words:
        return out

    # Cluster into text lines by y baseline.
    band_words.sort(key=lambda p: (p[0], p[2]))
    lines: list[list[tuple[float, float, float, float, str]]] = []
    for w in band_words:
        if lines and abs(w[0] - lines[-1][-1][0]) <= 4.0:
            lines[-1].append(w)
        else:
            lines.append([w])

    # Keep the two lines closest to the table (largest y).
    lines.sort(key=lambda ln: -max(w[1] for w in ln))
    target_lines = lines[:2]

    per_col: dict[int, list[tuple[float, float, str]]] = {c: [] for c in range(num_cols)}
    for ln in target_lines:
        for wy0, _wy1, wx0, wx1, t in ln:
            cx = (wx0 + wx1) / 2
            for c in range(num_cols):
                if table.col_bounds[c] <= cx <= table.col_bounds[c + 1]:
                    per_col[c].append((wy0, wx0, t))
                    break
    for c, parts in per_col.items():
        if not parts:
            continue
        parts.sort(key=lambda p: (p[0], p[1]))
        out[c] = " ".join(p[2] for p in parts[:6]).strip()
    return out


def _clean_label(text: str) -> str:
    # Trim trailing colons / asterisks / parentheses noise.
    t = text.strip()
    t = re.sub(r"[\:\*\-–—]+$", "", t).strip()
    return t


def _find_label_near(
    rect: Rect,
    words: list[tuple[float, float, float, float, str]],
    page_w: float,
    page_h: float,
) -> tuple[str, float]:
    """For standalone fields: words to the left (same row) and above."""
    band_top = max(0.0, rect.y - 28.0)
    band_bot = rect.y + 4.0
    band_left = max(0.0, rect.x - min(280.0, page_w * 0.4))
    parts_left: list[tuple[float, str]] = []
    parts_above: list[tuple[float, float, str]] = []
    for wx0, wy0, wx1, wy1, t in words:
        if _is_underscore_filler(t):
            continue
        cx = (wx0 + wx1) / 2
        cy = (wy0 + wy1) / 2
        if band_left <= cx <= rect.x and (rect.y <= cy <= rect.y1):
            parts_left.append((wx0, t.strip()))
            continue
        if band_top <= cy <= band_bot and rect.x - 80 <= cx <= rect.x1 + 8:
            parts_above.append((wy0, wx0, t.strip()))
    parts_left.sort(key=lambda p: p[0])
    parts_above.sort(key=lambda p: (-p[0], p[1]))
    if parts_left:
        return _clean_label(" ".join(p[1] for p in parts_left[-8:])), 0.7
    if parts_above:
        return _clean_label(" ".join(p[2] for p in parts_above[:8])), 0.6
    return "", 0.0


# ---------- Stage D: type classification --------------------------------- #


# Default keyword map; overridden by the JSON config when present.
DEFAULT_FIELD_TYPE_KEYWORDS: dict[str, list[str]] = {
    "signature": ["sign", "signature", "authorize", "approval", "witness", "approved by"],
    "time": ["time", "clock", "hour", "hh:mm"],
    "date": ["date", "mfg date", "manufactur", "expir", "due date", "day/month", "month/day"],
    "checkbox": ["yes", "no", "pass", "fail", "n/a", "y/n", "☐", "□", "verified"],
    "number": [
        "temp", "temperature", "pressure", "weight", "volume", "qty",
        "quantity", "amount", "lot", "batch", "id", "#", "ph", "conc",
        "titer", "count", "ppm", "%", "degrees", "number", "no.",
    ],
    "text": ["initial", "initialed", "inits", "by:", "operator", "performed by", "completed by"],
}

FIELD_TYPE_ORDER: tuple[str, ...] = ("checkbox", "date", "time", "number", "signature", "text")


def _label_matches_keyword(label: str, kw: str) -> bool:
    if not kw:
        return False
    if kw == "#":
        return "#" in label
    if any(ch in kw for ch in "☐□"):
        return kw in label
    esc = re.escape(kw)
    # Keywords ending in "." (abbreviations like "no.") need an open
    # right boundary — \b right after a literal period never matches.
    if kw.endswith("."):
        pattern = rf"\b{esc}"
    else:
        pattern = rf"\b{esc}\b"
    # Short tokens that double as abbreviation roots ("No." → "Number")
    # would otherwise produce false positives for checkbox column heads.
    if kw in {"no", "yes"}:
        m = re.search(pattern, label)
        if not m:
            return False
        end = m.end()
        if end < len(label) and label[end] == ".":
            return False
        return True
    return bool(re.search(pattern, label))


def classify_field_type(
    label: str,
    keyword_map: dict[str, list[str]],
    geometry_hint: str | None = None,
) -> str:
    """Pick a field type for a label, optionally biased by geometry.

    `geometry_hint` may be one of:
        - "tiny_square"  → strong push to "checkbox"
        - "large_box"    → push to "signature" when label hints, else "text"
        - "wide_short"   → text/date/number per keyword
        - "narrow_tall"  → text
        - None           → keyword only
    """
    t = (label or "").lower()
    t = re.sub(r"\s+", " ", t).strip()
    # "verified by" is the operator NAME, not a checkbox.
    if re.search(r"\bverified\s*by\b", t):
        return "text"

    if geometry_hint == "tiny_square":
        return "checkbox"

    # Ambiguous label fallback: if the text looks like multiple labels
    # mashed together (multiple colons or many words), we can't reliably
    # infer a single data type — emit as free text. The geometry hint
    # still wins above for clearly-shaped fields (tiny_square).
    if t.count(":") >= 2 or len(t.split()) >= 5:
        if geometry_hint == "large_box" and re.search(r"\bsign|approv|witness", t):
            return "signature"
        return "text"

    for ftype in FIELD_TYPE_ORDER:
        for kw in keyword_map.get(ftype, []):
            if _label_matches_keyword(t, kw.lower()):
                if ftype == "checkbox" and geometry_hint not in {"tiny_square", None}:
                    # A wide cell labelled "Yes/No verified" is more likely a
                    # text input answering yes/no — bump to text unless the
                    # geometry actually looks like a checkbox.
                    continue
                return ftype

    if geometry_hint == "large_box":
        if re.search(r"\bsign|approv|witness", t):
            return "signature"
    return "text"


def _group_stacked_underlines(
    underlines: list[HLine],
    words: list[tuple[float, float, float, float, str]],
    x_tol: float = 6.0,
    y_gap_max: float = 28.0,
) -> list[list[HLine]]:
    """Group vertically-stacked underlines that share an x-range.

    A multi-line notes/comments area is N parallel underlines at the same
    width, separated by a single line-height. We collapse those into one
    "block" so the form builder gets one paragraph field.

    Underlines that have their own per-line label to the left ("Product
    Name: ___" stacked over "Batch Number: ___") are NOT merged — those
    are separate fields, even though the underlines share an x-range.
    """
    if not underlines:
        return []
    by_y = sorted(underlines, key=lambda h: (round(h.x0), h.y))
    # Pre-compute which underlines have a left-side label.
    has_label = {i: _underline_has_left_label(h, words) for i, h in enumerate(by_y)}
    groups: list[list[HLine]] = []
    used: set[int] = set()
    for i, h in enumerate(by_y):
        if i in used:
            continue
        group = [h]
        group_indices = [i]
        used.add(i)
        # Greedy walk: anything with same x bounds within y_gap_max of
        # the latest line joins — unless either line carries its own
        # left-side label.
        changed = True
        while changed:
            changed = False
            for j, other in enumerate(by_y):
                if j in used:
                    continue
                last = group[-1]
                if abs(other.x0 - last.x0) > x_tol:
                    continue
                if abs(other.x1 - last.x1) > x_tol:
                    continue
                if not (0 < (other.y - last.y) <= y_gap_max):
                    continue
                # Skip the merge when EITHER line has its own label —
                # these are distinct "Label: ___" entries.
                if has_label[group_indices[-1]] or has_label[j]:
                    continue
                group.append(other)
                group_indices.append(j)
                used.add(j)
                changed = True
        groups.append(group)
    return groups


def _underline_has_left_label(
    line: HLine,
    words: list[tuple[float, float, float, float, str]],
    search_x: float = 240.0,
    baseline_tol: float = 8.0,
) -> bool:
    """Heuristic: is there a label phrase on the same baseline to the line's left?

    A "label phrase" is text whose right edge sits close to the line's
    left edge, on roughly the same baseline. Requires at least 3 letters
    OR a trailing colon to count.
    """
    if line.x1 <= line.x0:
        return False
    band_min_x = max(0.0, line.x0 - search_x)
    candidates: list[tuple[float, float, str]] = []
    for wx0, wy0, wx1, wy1, t in words:
        if _is_underscore_filler(t):
            continue
        cy = (wy0 + wy1) / 2
        if abs(cy - line.y) > baseline_tol:
            continue
        cx = (wx0 + wx1) / 2
        if cx >= line.x0:
            continue
        if cx < band_min_x:
            continue
        candidates.append((wx1, wx0, t.strip()))
    if not candidates:
        return False
    # Take the rightmost contiguous group (closest to the line).
    candidates.sort(key=lambda c: c[1])
    text = " ".join(c[2] for c in candidates[-6:])
    if ":" in text:
        return True
    letters = sum(1 for ch in text if ch.isalpha())
    return letters >= 3


def _geometry_hint_for(rect: Rect) -> str | None:
    if rect.w <= 0 or rect.h <= 0:
        return None
    ar = rect.w / rect.h
    area = rect.w * rect.h
    if rect.w <= 22 and rect.h <= 22 and 0.7 <= ar <= 1.4:
        return "tiny_square"
    if area >= 8000 and rect.h >= 40:
        return "large_box"
    if ar >= 3.0:
        return "wide_short"
    if ar <= 0.6:
        return "narrow_tall"
    return None


# ---------- Pipeline driver --------------------------------------------- #


def emit_page_fields(
    geom: PageGeometry,
    keyword_map: dict[str, list[str]],
    debug_records: list[dict[str, Any]] | None = None,
    injected_headers_by_table: dict[int, dict[int, str]] | None = None,
) -> list[Suggestion]:
    """Run Stages B → C → D for a page. Output is ready for the response.

    `injected_headers_by_table` lets the orchestrator inherit column
    headers from a previous page's matching table (Fix #1 — header carry).
    """
    page_num = geom.page_num
    words = geom.words
    out: list[Suggestion] = []

    # ---- Tables ---------------------------------------------------------
    # First pass: capture text per cell so Stage C can look at neighbours.
    table_cell_texts: dict[int, dict[tuple[int, int], str]] = {}
    for table in geom.tables:
        cell_texts: dict[tuple[int, int], str] = {}
        for cell in table.cells:
            cell_texts[(cell.row, cell.col)] = _cell_text(cell, words)
        table_cell_texts[table.id] = cell_texts

    for table in geom.tables:
        cell_texts = table_cell_texts[table.id]
        num_cols = len(table.col_bounds) - 1
        injected_headers = (
            (injected_headers_by_table or {}).get(table.id)
        )

        # Column-level type voting: classify each column's header text
        # once and apply that field type to every input cell in the
        # column. This keeps a "Start Time" column from leaking text
        # inputs into rows whose individual labels lack the time keyword.
        column_types: dict[int, str] = {}
        column_header_texts: dict[int, str] = {}
        if num_cols >= 3:
            num_rows = len(table.row_bounds) - 1
            text_above = _column_headers_from_text_above(
                table, words, search_height=40.0,
            )
            # When row 0 is a single merged cell (column dividers don't
            # reach the table top), the header text lives inside it. We
            # also bucket those words by x-position into columns.
            header_row_words = _header_row_words_by_col(table, words)
            for col in range(num_cols):
                header_text = ""
                for r in range(num_rows):
                    cand = cell_texts.get((r, col), "")
                    if not _label_has_data(cand):
                        continue
                    cells_in_row = [
                        cell_texts.get((r, cc), "") for cc in range(num_cols)
                    ]
                    text_count = sum(1 for t in cells_in_row if _label_has_data(t))
                    if text_count >= max(2, num_cols // 2):
                        header_text = _clean_label(cand)
                        break
                if not header_text:
                    hr = header_row_words.get(col, "")
                    if _label_has_data(hr):
                        header_text = _clean_label(hr)
                if not header_text:
                    above = text_above.get(col, "")
                    if _label_has_data(above):
                        header_text = _clean_label(above)
                if not header_text and injected_headers:
                    inj = injected_headers.get(col, "")
                    if _label_has_data(inj):
                        header_text = _clean_label(inj)
                if header_text:
                    column_types[col] = classify_field_type(header_text, keyword_map)
                    column_header_texts[col] = header_text

        for cell in table.cells:
            # Skip cells that are too small to plausibly hold an input.
            # Inter-table seam rows often produce ~5-9 pt-tall "cells"
            # whose only role is to separate two real tables.
            if cell.bbox.h < 10.0 or cell.bbox.w < 16.0:
                if debug_records is not None:
                    debug_records.append({
                        "stage": "cell",
                        "tableId": cell.table_id,
                        "row": cell.row, "col": cell.col,
                        "decision": "skipped_tiny",
                        "h": round(cell.bbox.h, 1),
                        "w": round(cell.bbox.w, 1),
                    })
                continue
            text = cell_texts[(cell.row, cell.col)]
            words_in_cell = _words_in(words, cell.bbox, inset=0.5)
            role = _cell_role(text, words_in_cell)

            if role == "label":
                if debug_records is not None:
                    debug_records.append({
                        "stage": "cell",
                        "tableId": cell.table_id,
                        "row": cell.row, "col": cell.col,
                        "decision": "label",
                        "text": text,
                    })
                continue

            row_id, col_header, label_conf = _find_label_parts_for_cell(
                cell, table, cell_texts, injected_col_headers=injected_headers,
            )
            # If the per-cell search found no col header, fall back to
            # the table-level header inferred from text above the table.
            if not col_header and column_header_texts.get(cell.col):
                col_header = column_header_texts[cell.col]
                if not label_conf:
                    label_conf = 0.6
            display_label = _compose_display_label(row_id, col_header, num_cols)

            if not _label_has_data(display_label):
                # Fall back to nearby off-table text.
                display_label, fallback_conf = _find_label_near(
                    cell.bbox, words, geom.page_w, geom.page_h,
                )
                if _label_has_data(display_label):
                    label_conf = fallback_conf
            if role == "empty" and not _label_has_data(display_label):
                # Last-ditch: column-position descriptor so log tables with
                # neither headers nor row ids still emit fields the user
                # can rename.
                display_label = f"Column {cell.col + 1}"
                label_conf = 0.2

            if role == "checkbox":
                # Yes/No prompt cell — emit a checkbox labelled by row id.
                label = row_id or display_label or "Checkbox"
                if not _label_has_data(label):
                    label = "Checkbox"
                out.append(_emit_from_cell(
                    cell, label, row_id, col_header, label_conf,
                    field_type="checkbox", page_num=page_num,
                    kind="cell_checkbox",
                ))
                if debug_records is not None:
                    debug_records.append({
                        "stage": "cell",
                        "tableId": cell.table_id,
                        "row": cell.row, "col": cell.col,
                        "decision": "checkbox_prompt",
                        "label": label,
                    })
                continue

            hint = _geometry_hint_for(cell.bbox)
            # Prefer the column-level type (voted from the column's
            # header) so a column reads as one consistent data type.
            ftype = column_types.get(cell.col) or classify_field_type(
                display_label, keyword_map, geometry_hint=hint,
            )
            out.append(_emit_from_cell(
                cell, display_label, row_id, col_header, label_conf,
                field_type=ftype, page_num=page_num,
            ))
            if debug_records is not None:
                debug_records.append({
                    "stage": "cell",
                    "tableId": cell.table_id,
                    "row": cell.row, "col": cell.col,
                    "decision": "input",
                    "label": display_label,
                    "rowId": row_id,
                    "colHeader": col_header,
                    "fieldType": ftype,
                    "labelConfidence": round(label_conf, 2),
                })

    # ---- Standalone underlines -----------------------------------------
    # Merge vertically-stacked underlines that share an x range (e.g.
    # the multi-line NOTES section) into one free-text block. Lone
    # underlines stay as single-line fields.
    underline_groups = _group_stacked_underlines(geom.standalone_underlines, words)
    for group in underline_groups:
        if len(group) >= 2:
            x0 = min(h.x0 for h in group)
            x1 = max(h.x1 for h in group)
            ys = sorted(h.y for h in group)
            top_line_y = ys[0]
            bot_line_y = ys[-1]
            line_height = max(18.0, min(32.0, geom.page_h * 0.027))
            # Field stretches from just above the topmost line down to the
            # bottommost line (each line is a writing baseline).
            field_y = max(0.0, top_line_y - line_height)
            field_h = max(line_height, bot_line_y - field_y)
            label_anchor = Rect(x=x0, y=top_line_y - 1, w=x1 - x0, h=2.0)
            label, label_conf = _find_label_near(label_anchor, words, geom.page_w, geom.page_h)
            if not _label_has_data(label):
                # Try anchoring the search at the topmost line instead.
                label = ""
                label_conf = 0.3
            out.append(Suggestion(
                page=page_num,
                kind="standalone_underline_block",
                field_type="text",
                x=x0,
                y=field_y,
                width=max(40.0, x1 - x0),
                height=field_h,
                label_text=label or "Notes",
                confidence=0.6 if label_conf >= 0.6 else 0.5,
                from_cell=False,
                label_confidence=label_conf,
            ))
        else:
            line = group[0]
            rect = Rect(x=line.x0, y=line.y - 1, w=line.x1 - line.x0, h=2.0)
            label, label_conf = _find_label_near(rect, words, geom.page_w, geom.page_h)
            if not _label_has_data(label):
                continue
            hint = _geometry_hint_for(
                Rect(x=line.x0, y=line.y - 18, w=line.x1 - line.x0, h=22),
            )
            ftype = classify_field_type(label, keyword_map, geometry_hint=hint)
            out.append(_emit_from_underline(line, label, label_conf, ftype, page_num, geom.page_h))

    # ---- Standalone closed boxes ---------------------------------------
    for box in geom.standalone_boxes:
        label, label_conf = _find_label_near(box, words, geom.page_w, geom.page_h)
        if not _label_has_data(label):
            continue
        hint = _geometry_hint_for(box)
        ftype = classify_field_type(label, keyword_map, geometry_hint=hint)
        out.append(_emit_from_box(box, label, label_conf, ftype, page_num))

    # ---- Checkbox candidates ------------------------------------------
    for cb in geom.checkbox_candidates:
        label, label_conf = _find_label_near(cb, words, geom.page_w, geom.page_h)
        if not _label_has_data(label):
            label = "Checkbox"
            label_conf = 0.3
        out.append(_emit_checkbox(cb, label, label_conf, page_num))

    return out
