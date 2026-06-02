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

from .geometry import (
    Cell,
    HLine,
    PageGeometry,
    Rect,
    Table,
    VLine,
    _build_single_grid,
)


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
    # Repeating-row hint: when a table looks like a homogeneous data log
    # (UFDF pressure/flow rows, fill-check Tare/Gross/Net rows, operator
    # identification grids), every cell carries `repeating=True` plus a
    # shared `repeat_group_id` and a row index within the group. The
    # frontend can choose to collapse these into one "+ Add row" widget.
    repeating: bool = False
    repeat_group_id: str = ""
    repeat_row_index: int = 0
    repeat_rows_observed: int = 0
    # Machine-readable, snake_case identifier — unique across the
    # document. Assigned after label disambiguation.
    name: str = ""


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
    """Concatenated text inside a cell in natural reading order
    (top-to-bottom, then left-to-right). Underscore-fillers skipped.

    Words on the same visual line can show 1-2pt of baseline jitter
    (e.g., a glyph with descenders + a glyph without), and a fixed-period
    bucket like ``round(y/3)*3`` can split them across adjacent buckets
    when the boundary happens to fall inside the jitter. We greedily
    cluster word tops within ``BASELINE_TOL`` of each other instead, so
    a label like "Storage Temperature (2-8 °C)" reads in order even
    when "°C)" sits a fraction of a point above the rest of the line.
    """
    BASELINE_TOL = 4.0
    raw = [
        (wx0, wy0, t.strip())
        for wx0, wy0, _wx1, _wy1, t in _words_in(words, cell.bbox, inset=0.5)
        if not _is_underscore_filler(t)
    ]
    if not raw:
        return ""
    raw.sort(key=lambda p: (p[1], p[0]))
    # Greedy line-clustering on word tops.
    lines: list[list[tuple[float, float, str]]] = []
    current: list[tuple[float, float, str]] = []
    current_y = float("nan")
    for wx0, wy0, t in raw:
        if not current or abs(wy0 - current_y) <= BASELINE_TOL:
            current.append((wx0, wy0, t))
            current_y = (
                sum(p[1] for p in current) / len(current)
                if not current_y == current_y else  # NaN check
                current_y * 0.5 + wy0 * 0.5
            )
            # Always recompute mean to stay anchored to the cluster.
            current_y = sum(p[1] for p in current) / len(current)
        else:
            lines.append(current)
            current = [(wx0, wy0, t)]
            current_y = wy0
    if current:
        lines.append(current)
    out: list[str] = []
    for line in lines:
        line.sort(key=lambda p: p[0])
        out.extend(p[2] for p in line if p[2])
    return " ".join(out).strip()


def _label_has_data(label: str) -> bool:
    if not label:
        return False
    alnum = re.findall(r"[A-Za-z0-9]", label)
    return len(alnum) >= 2


_CHECKBOX_TOKEN_RE = re.compile(
    r"\b(yes|no|y/n|n/a|pass|fail)\b", re.IGNORECASE,
)
_CHECKBOX_GLYPH_CHARS = set("☐□✓✔☑☑☒")


def _is_checkbox_prompt(text: str) -> bool:
    """Detect cells whose value is a Yes/No-style prompt.

    A "prompt" cell is a binary-choice marker the user picks between —
    we recognise it only when the text clearly contains one of those
    pairs (yes+no, pass+fail) or stands alone as a single yes/no token.
    A lone "No" inside a longer phrase is NOT a checkbox: "Version No.",
    "No. of items", and the like would otherwise be mis-classified.
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
    word_count = len(re.findall(r"[A-Za-z]+", cleaned))
    if word_count > 4:
        # A long cell is still a checkbox prompt when it asks a question
        # whose binary answer trails the text — e.g.
        # "Storage time at 2-8 °C < 48 hours? Yes / No" or
        # "Is mRNA solution completely thawed? … Yes / No".
        # We require a literal "?" anywhere in the cell AND both poles
        # of a binary pair in the trailing portion, so a long
        # descriptive sentence that incidentally mentions "yes" or "no"
        # won't trip the rule.
        if "?" not in cleaned:
            return False
        tail = cleaned[-60:]
        tail_tokens = {
            m.group(0).lower()
            for m in _CHECKBOX_TOKEN_RE.finditer(tail)
        }
        if {"yes", "no"} <= tail_tokens or {"pass", "fail"} <= tail_tokens:
            return True
        return False
    tokens = {m.group(0).lower() for m in _CHECKBOX_TOKEN_RE.finditer(cleaned)}
    if not tokens:
        return False
    # Binary prompts: explicit yes/no or pass/fail pair.
    if {"yes", "no"} <= tokens or {"pass", "fail"} <= tokens:
        return True
    # Explicit y/n marker (single token "Y/N" is a checkbox prompt).
    if "y/n" in tokens:
        return True
    # Standalone single-token prompts ("Yes", "No", "Pass", "Fail").
    # "N/A" alone is *not* a prompt — it's a "not applicable" marker
    # filling the cell with static content.
    if word_count == 1 and tokens & {"yes", "no", "pass", "fail"}:
        return True
    return False


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


def _split_tall_empty_cells(
    table: Table,
    cell_texts: dict[tuple[int, int], str],
    words: list[tuple[float, float, float, float, str]],
) -> list[Cell]:
    """Return the table's cells with any tall, empty merged cell
    virtually subdivided into one cell per neighbouring-column row.

    Some forms render the rightmost column ("Recorded By/Date" on an
    Equipment table, etc.) as a single tall cell spanning every data
    row, because the inner row separators don't extend to the right
    edge. The cell-emission loop sees one cell → emits one field, when
    the operator clearly needs to fill in one signature per equipment.

    For each empty cell with `row_span > 2`, we replace it with N virtual
    sub-cells aligned to the row bounds of a neighbouring column. The
    sub-cells inherit the parent's column index and carry per-row row
    indexes so the existing `_find_label_parts_for_cell` picks up the
    correct `row_id` from col 0.

    Cells that already span just one row, or that contain content, are
    returned unchanged. `cell_texts` is updated in place with empty
    entries for each new virtual sub-cell.
    """
    out: list[Cell] = []
    num_rows = len(table.row_bounds) - 1
    if num_rows < 3:
        return list(table.cells)

    # Group existing cells by column so we can find a "donor" column
    # whose per-row rows we can copy.
    cells_by_col: dict[int, list[Cell]] = {}
    for c in table.cells:
        cells_by_col.setdefault(c.col, []).append(c)

    for cell in table.cells:
        if cell.row_span <= 2 or cell.col_span > 1:
            out.append(cell)
            continue
        # Find a donor column with one cell per row inside the merged
        # cell's row range. Pick the column with the *most* cells in
        # that range (typically the row-id column).
        first_row = cell.row
        last_row = cell.row + cell.row_span - 1
        best_donor: list[Cell] | None = None
        best_count = 0
        for c, group in cells_by_col.items():
            if c == cell.col:
                continue
            within = [g for g in group if first_row <= g.row <= last_row and g.row_span == 1]
            if len(within) > best_count:
                best_donor = within
                best_count = len(within)
        if not best_donor or best_count < 3:
            out.append(cell)
            continue
        # Only split when the merged cell's content is concentrated in
        # the donor row at the very top — i.e., the cell looks like
        # "<header text> + N empty data rows" (the Equipment "Recorded
        # By/Date" column, the BoM "Recorded By/Date" column). A
        # legitimate container cell (a signature block whose text sits
        # in a middle row, an instructions paragraph) keeps text
        # elsewhere and should stay a single field.
        def _row_has_text(donor_cell: Cell) -> bool:
            y_low, y_high = donor_cell.bbox.y, donor_cell.bbox.y1
            for wx0, wy0, wx1, wy1, t in words:
                if not _label_has_data(t):
                    continue
                if _is_underscore_filler(t):
                    continue
                cx = (wx0 + wx1) / 2
                cy = (wy0 + wy1) / 2
                if (
                    cell.bbox.x <= cx <= cell.bbox.x1
                    and y_low <= cy <= y_high
                ):
                    return True
            return False

        donors_sorted = sorted(best_donor, key=lambda d: d.row)
        # The first donor row may carry the merged cell's header text
        # (e.g., "Recorded By"). All *other* donor rows must be empty
        # within the merged cell's x-range; otherwise this is a
        # container with content distributed across multiple rows.
        head_donor = donors_sorted[0]
        tail_donors = donors_sorted[1:]
        if any(_row_has_text(d) for d in tail_donors):
            out.append(cell)
            continue
        # If even the first donor row is empty, that's fine too —
        # this is the gap-#9 "fully merged empty column" case.
        _ = head_donor  # explicit no-op — accepted regardless
        # Synthesize one virtual sub-cell per donor row. Carry forward
        # any text that lives in that vertical band so the existing
        # role detector can mark filled donor rows (e.g., the header)
        # as labels.
        for donor in sorted(best_donor, key=lambda g: g.row):
            sub_bbox = Rect(
                x=cell.bbox.x,
                y=donor.bbox.y,
                w=cell.bbox.w,
                h=donor.bbox.h,
            )
            sub_cell = Cell(
                table_id=cell.table_id,
                row=donor.row,
                col=cell.col,
                row_span=1,
                col_span=1,
                bbox=sub_bbox,
            )
            out.append(sub_cell)
            cell_texts.setdefault(
                (donor.row, cell.col),
                _cell_text(sub_cell, words),
            )
    return out


def _is_informational_table(
    table: Table,
    cell_texts: dict[tuple[int, int], str],
    words: list[tuple[float, float, float, float, str]],
) -> bool:
    """True when a table reads as static content (TOC, references, etc.)
    rather than a form to be filled in.

    A TOC or references block is a grid where virtually every cell already
    holds text — there are no empty cells adjacent to filled ones, so the
    "label → input slot" pattern that drives field emission is absent.
    Emitting inputs over such cells just clutters the form builder.

    The cell-role check filters underscore fillers, so a cell whose only
    content is `____` still counts as empty.
    """
    # A cell merged across a substantial fraction of the table's rows
    # (≥40%) — or merged across ≥3 columns — is a "container" cell
    # that likely wraps a nested label/value sub-grid (e.g., the
    # Instructions cell of a Step|Instructions|Signature page spans
    # ~14 of 16 rows). Smaller row-grouping merges in static content
    # tables (Analytical Testing Summary's 3-5 row sample-label groups
    # in a 22-row table) don't qualify and the informational check
    # below still skips those tables.
    num_rows_total = len(table.row_bounds) - 1
    row_threshold = max(5, int(num_rows_total * 0.4))
    for cell in table.cells:
        if cell.row_span >= row_threshold or cell.col_span >= 3:
            return False

    label_cells: set[tuple[int, int]] = set()
    input_cells: set[tuple[int, int]] = set()
    for cell in table.cells:
        # Match the emission loop's filter: skip inter-table seam rows
        # whose tiny cells aren't plausible inputs anyway.
        if cell.bbox.h < 10.0 or cell.bbox.w < 16.0:
            continue
        text = cell_texts.get((cell.row, cell.col), "")
        words_in_cell = _words_in(words, cell.bbox, inset=0.5)
        role = _cell_role(text, words_in_cell)
        if role == "label":
            label_cells.add((cell.row, cell.col))
        else:
            input_cells.add((cell.row, cell.col))

    total = len(label_cells) + len(input_cells)
    if total < 4:
        # Too small to classify reliably — let the normal logic run.
        return False

    if not input_cells:
        # Nothing would have been emitted anyway, but reporting it as
        # informational keeps the debug overlay coherent.
        return True

    label_ratio = len(label_cells) / total
    if label_ratio < 0.85:
        return False

    # Of the few remaining empties, count those sitting right of or below
    # a labelled cell — the canonical "label → input slot" arrangement.
    # If even one or two empties look like real slots we err on the side
    # of emitting fields; only when essentially every empty cell looks
    # incidental do we treat the whole table as static.
    structural_slots = 0
    for r, c in input_cells:
        if (r, c - 1) in label_cells or (r - 1, c) in label_cells:
            structural_slots += 1
    return structural_slots <= 1


def _box_has_input_area(
    box: Rect,
    words: list[tuple[float, float, float, float, str]],
) -> bool:
    """True when a standalone bordered region looks like an input zone.

    Only two patterns count as inputs:
      * Empty box — no meaningful text inside.
      * "Label: ___" pattern — some text ending in ":" with a clear
        empty stretch to its right where a value would go.

    Bordered text blocks (headings, callouts, paragraphs surrounded by
    a border for styling) match neither and should not spawn fields.
    """
    inset = 1.5
    inside = [
        w for w in _words_in(words, box, inset=inset)
        if not _is_underscore_filler(w[4])
        and any(ch.isalnum() for ch in w[4])
    ]
    if not inside:
        return True  # Empty bordered region → real input.

    box_left = box.x + inset
    box_right = box.x1 - inset
    box_w = max(1.0, box_right - box_left)

    # Group words into baseline-aligned rows (~4 pt tolerance).
    inside.sort(key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    rows: list[list[tuple[float, float, float, float, str]]] = []
    for w in inside:
        cy = (w[1] + w[3]) / 2
        if rows:
            last_row = rows[-1]
            last_cy = sum((u[1] + u[3]) / 2 for u in last_row) / len(last_row)
            if abs(last_cy - cy) <= 4.0:
                last_row.append(w)
                continue
        rows.append([w])

    for row_words in rows:
        row_words.sort(key=lambda w: w[0])
        text_concat = " ".join(w[4] for w in row_words)
        rightmost_x1 = max(w[2] for w in row_words)
        trailing_space = box_right - rightmost_x1
        # "Label:" stub followed by meaningful empty space → input row.
        if ":" in text_concat and trailing_space >= max(40.0, box_w * 0.25):
            return True

    return False


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


_UNDERSCORE_INPUT_RE = re.compile(r"^(=?\s*)(_{4,})(.*)$")
_UNIT_SUFFIX_RE = re.compile(r"^[A-Za-zµμ°·/%]{1,8}$")
_STEP_IDENTIFIER_RE = re.compile(
    r"^\s*(step(\s*(no\.?|number|#))?|#|no\.?|item|seq(uence)?)\s*$",
    re.IGNORECASE,
)


def _is_step_identifier_header(header: str) -> bool:
    """True when a column header marks a process-step identifier column
    (and so empty cells in that column are layout markers, not inputs)."""
    if not header:
        return False
    return bool(_STEP_IDENTIFIER_RE.match(header.strip()))


def _summarize_instruction(text: str) -> str:
    """Compress an instruction paragraph into a short anchor suitable for
    use as a row_id.

    Sentence-splitting (e.g., "Obtain a clean vessel.") truncates two
    *different* steps to the same intro phrase. Instead, take the
    leading slice of the *flattened* text up to ~120 chars, breaking at
    a word boundary, so neighbouring sentences contribute discriminating
    content when the first one is generic.
    """
    flat = re.sub(r"\s+", " ", (text or "").strip())
    if not flat:
        return ""
    if len(flat) <= 120:
        return flat
    cut = flat[:120]
    # Prefer the last sentence/clause boundary inside the window so we
    # don't stop mid-thought; fall back to the last whitespace.
    for delim in (". ", "; ", ", ", " "):
        idx = cut.rfind(delim)
        if idx >= 60:
            cut = cut[:idx]
            break
    return cut.rstrip(" .,;") + "..."


def _build_step_index(
    geom: PageGeometry,
    table_cell_texts: dict[int, dict[tuple[int, int], str]],
) -> list[tuple[float, float, str]]:
    """Build a per-page index of (y_min, y_max, step_label) for outer
    process-step tables (`Step | Instructions | Signature` and friends).

    Used to attach a step identifier as `row_id` to free-floating
    underscore inputs (`Performed by/Date _______`) and merged-cell
    nested fields. Without this, every `Performed by/Date` on every page
    disambiguates with `(page N)` instead of a meaningful step anchor.

    The step label comes from:
      1. The Step column cell text (e.g., ``9.1.1.`` on ARCT-032), or
      2. The first sentence-ish chunk of the Instructions cell when the
         Step column is blank (ARCT-2601 / COVID-2LYO layout).
    """
    index: list[tuple[float, float, str]] = []
    for table in geom.tables:
        num_cols = len(table.col_bounds) - 1
        num_rows = len(table.row_bounds) - 1
        if num_cols < 2 or num_rows < 2:
            continue
        cell_texts = table_cell_texts.get(table.id, {})
        col0_header = (cell_texts.get((0, 0), "") or "").strip()
        if not _is_step_identifier_header(col0_header):
            continue

        # When a step's Instructions cell hosts a nested label/value
        # sub-grid, the inner row dividers can split the outer step row
        # into many geometry rows — col 0 holds the step id only on the
        # top sliver, and the rest of the rows are empty. Walk through
        # the outer rows once, anchoring on each row whose col 0 (or
        # col 1, as a fallback) carries text; extend that step's
        # y-range until the next anchor.
        anchors: list[tuple[int, str]] = []
        for row in range(1, num_rows):
            label = (cell_texts.get((row, 0), "") or "").strip()
            label = label.rstrip(".").strip()
            if not _label_has_data(label):
                instr = (cell_texts.get((row, 1), "") or "").strip()
                if _label_has_data(instr):
                    label = _summarize_instruction(instr)
            if _label_has_data(label):
                anchors.append((row, label))

        for i, (row, label) in enumerate(anchors):
            y0 = table.row_bounds[row]
            if i + 1 < len(anchors):
                y1 = table.row_bounds[anchors[i + 1][0]]
            else:
                y1 = table.row_bounds[num_rows]
            index.append((y0, y1, label))
    return index


def _step_label_at(
    step_index: list[tuple[float, float, str]],
    y: float,
    tol: float = 6.0,
) -> str:
    """Return the step label whose y-range contains `y`, or empty."""
    for y0, y1, label in step_index:
        if y0 - tol <= y <= y1 + tol:
            return label
    return ""


def _is_unit_suffix(s: str) -> bool:
    """True when a suffix like 'mg', 'mL', 'g/mL', '%' looks like a
    measurement unit (and therefore implies a numeric input)."""
    if not s:
        return False
    return bool(_UNIT_SUFFIX_RE.match(s.strip()))


def _unit_word_to_right(
    rect: Rect,
    words: list[tuple[float, float, float, float, str]],
    max_dx: float = 22.0,
    baseline_tol: float = 4.0,
) -> str | None:
    """If a unit token (`mg`, `mL`, `%`, ...) sits immediately to the
    right of the slot on the same baseline, return it. Used to flag
    `_______________  mg` style inputs as numeric even when no unit is
    appended to the underscore word itself."""
    cy_rect = rect.y + rect.h / 2
    for wx0, wy0, wx1, wy1, t in words:
        cy = (wy0 + wy1) / 2
        if abs(cy - cy_rect) > baseline_tol:
            continue
        if wx0 <= rect.x1:
            continue
        if wx0 - rect.x1 > max_dx:
            continue
        if _is_unit_suffix(t.strip()):
            return t.strip()
    return None


def _scan_underscore_inputs(
    words: list[tuple[float, float, float, float, str]],
) -> list[dict[str, Any]]:
    """Find words that visually act as fill-in slots (`____`, `____mg`,
    `=____g`, etc.) and return one entry per slot."""
    out: list[dict[str, Any]] = []
    for wx0, wy0, wx1, wy1, t in words:
        m = _UNDERSCORE_INPUT_RE.match(t)
        if not m:
            continue
        prefix, underscores, suffix = m.group(1), m.group(2), m.group(3)
        if len(underscores) < 4:
            continue
        char_w = (wx1 - wx0) / max(1, len(t))
        ux0 = wx0 + len(prefix) * char_w
        ux1 = ux0 + len(underscores) * char_w
        out.append({
            "rect": Rect(x=ux0, y=wy0, w=max(8.0, ux1 - ux0), h=max(2.0, wy1 - wy0)),
            "baseline_y": wy1,
            "suffix": suffix.strip(),
            "orig": t,
        })
    return out


def _find_underscore_label(
    input_rect: Rect,
    words: list[tuple[float, float, float, float, str]],
    max_below: float = 32.0,
    max_above: float = 22.0,
) -> tuple[str, float]:
    """Choose a label for an underscore-text input.

    We collect candidate labels both BELOW and ABOVE the slot and
    pick whichever is closer to the rule. The below-side is the
    dominant pattern in process-step batch records (caption beneath
    the blank), but signature blocks have the label ABOVE and the
    next label-below would belong to the *next* signature rule —
    proximity is the reliable disambiguator.

    Up to two consecutive baselines are stitched together so wrapped
    labels ("Target mass of RNA with overage from step 9.2.1")
    aren't truncated mid-phrase.
    """
    x_min = input_rect.x - 6.0
    x_max = input_rect.x1 + 6.0
    # Max horizontal gap inside one caption cluster. Tighter than the
    # usual line-of-text spacing so neighbouring column captions on the
    # same baseline don't accidentally merge into one label.
    inter_word_gap = 10.0

    def _grab(y_low: float, y_high: float) -> tuple[str, float]:
        """Return (label, anchor_y) for caption text in the band.

        Captions are bucketed by baseline, then split into horizontal
        clusters by inter-word gap. Any cluster whose x range overlaps
        the input's column is taken whole — so a caption that extends
        past the input's right edge ("Target mass of RNA with overage")
        comes through intact instead of being truncated at the column
        edge.
        """
        cands: list[tuple[float, float, float, float, str]] = []
        # (cy, cx, wx0, wx1, text)
        for wx0, wy0, wx1, wy1, t in words:
            if _is_underscore_filler(t):
                continue
            cx, cy = (wx0 + wx1) / 2, (wy0 + wy1) / 2
            if y_low <= cy <= y_high:
                cands.append((cy, cx, wx0, wx1, t.strip()))
        if not cands:
            return "", float("inf")
        cands.sort(key=lambda c: (c[0], c[1]))
        # Bucket into baseline rows.
        lines: list[list[tuple[float, float, float, float, str]]] = [[cands[0]]]
        for c in cands[1:]:
            if abs(c[0] - lines[-1][-1][0]) <= 4.0:
                lines[-1].append(c)
            else:
                lines.append([c])
        text_parts: list[str] = []
        anchor: float | None = None
        for line in lines:
            line.sort(key=lambda c: c[1])
            # Cluster by horizontal gap.
            h_clusters: list[list[tuple[float, float, float, float, str]]] = [[line[0]]]
            for w in line[1:]:
                if w[2] - h_clusters[-1][-1][3] <= inter_word_gap:
                    h_clusters[-1].append(w)
                else:
                    h_clusters.append([w])
            line_matched = False
            for cluster in h_clusters:
                c_x0 = cluster[0][2]
                c_x1 = cluster[-1][3]
                # Keep cluster only when its x range overlaps the input
                # column. This prevents pulling sibling captions that
                # describe the *next* input on the same baseline.
                if c_x1 < x_min or c_x0 > x_max:
                    continue
                if anchor is None:
                    # Anchor the distance comparison to the cluster we
                    # actually matched, not the band's earliest word —
                    # otherwise a sibling caption from another column on
                    # the same y-band would skew distances.
                    anchor = cluster[0][0]
                text_parts.append(" ".join(w[4] for w in cluster))
                line_matched = True
            if line_matched and len(text_parts) >= 2:
                # Two matched baselines is enough; further lines belong
                # to a different caption block.
                break
            if not line_matched and text_parts:
                # We already collected at least one matching line and
                # the next baseline has no overlapping content — stop
                # before pulling in unrelated text further away.
                break
        if not text_parts or anchor is None:
            return "", float("inf")
        return _clean_label(" ".join(text_parts)), anchor

    below_text, below_y = _grab(input_rect.y1 + 1.0, input_rect.y1 + max_below)
    above_text, above_y = _grab(input_rect.y - max_above, input_rect.y - 1.0)

    has_below = _label_has_data(below_text)
    has_above = _label_has_data(above_text)
    if not (has_below or has_above):
        return "", 0.0

    if has_above and not has_below:
        return above_text, 0.6
    if has_below and not has_above:
        return below_text, 0.7

    # Both sides have candidates — pick the closer baseline.
    below_dist = below_y - input_rect.y1
    above_dist = input_rect.y - above_y
    if above_dist < below_dist:
        return above_text, 0.65
    return below_text, 0.7


def _emit_underscore_inputs(
    geom: PageGeometry,
    keyword_map: dict[str, list[str]],
    debug_records: list[dict[str, Any]] | None = None,
    step_index: list[tuple[float, float, str]] | None = None,
    table_cell_texts: dict[int, dict[tuple[int, int], str]] | None = None,
) -> list[Suggestion]:
    """Emit one input field per underscore-text slot.

    A slot inside an "empty" table cell is skipped — the cell-level
    emission already covers that case as a single input. Slots inside
    label cells (where the cell carries instructions plus several blank
    underscore runs) and slots outside any cell are emitted here.

    `step_index` (when supplied) maps y-ranges to the active process-step
    label on that page. Free-floating fields like `Performed by/Date ___`
    inherit that step as their `row_id`, so cross-page disambiguation
    can anchor on the step rather than the page number.

    `table_cell_texts` (when supplied) lets a slot sitting in a data cell
    of a multi-column grid (e.g., the lipid weight-range table) inherit
    the cell's row-label and column-header instead of falling back to
    the unit-suffix word (`mg`) that travels with the underline.
    """
    out: list[Suggestion] = []
    inputs = _scan_underscore_inputs(geom.words)
    if not inputs:
        return out

    tables_by_id = {t.id: t for t in geom.tables}

    # Pre-compute per-cell role so we don't re-classify N times.
    cell_role_cache: dict[tuple[int, int, int], str] = {}

    def _role_for(cell: Cell) -> str:
        key = (cell.table_id, cell.row, cell.col)
        cached = cell_role_cache.get(key)
        if cached is not None:
            return cached
        text = _cell_text(cell, geom.words)
        words_in_cell = _words_in(geom.words, cell.bbox, inset=0.5)
        role = _cell_role(text, words_in_cell)
        cell_role_cache[key] = role
        return role

    def _grid_label_for_cell(cell: Cell) -> tuple[str, str]:
        """Return ``(col_header, row_id)`` for a data cell in a 3+ col
        grid table, or ``("", "")`` if no clean labels are available.

        Mirrors the cell-emission path: column header from row 0 at the
        same column, row id from column 0 at the same row.
        """
        if cell.table_id is None or table_cell_texts is None:
            return "", ""
        if cell.row == 0 or cell.col == 0:
            return "", ""
        table = tables_by_id.get(cell.table_id)
        if table is None:
            return "", ""
        if len(table.col_bounds) - 1 < 3:
            return "", ""
        cell_texts = table_cell_texts.get(cell.table_id, {})
        col_hdr_txt = cell_texts.get((0, cell.col), "") or ""
        row_id_txt = cell_texts.get((cell.row, 0), "") or ""
        if not _label_has_data(col_hdr_txt) or not _label_has_data(row_id_txt):
            return "", ""
        return _clean_label(col_hdr_txt), _clean_label(row_id_txt)

    for u in inputs:
        rect: Rect = u["rect"]
        cx = rect.x + rect.w / 2
        cy = rect.y + rect.h / 2
        # An underline at (cx, cy) can fall inside multiple tables when
        # one table is visually nested inside another's merged cell
        # (e.g., the lipid weight-range grid sits inside the outer
        # Step|Instructions|Signature merged Instructions cell). Pick the
        # *smallest* containing cell so the inner data grid wins.
        containing_cell: Cell | None = None
        best_area = float("inf")
        for table in geom.tables:
            for cell in table.cells:
                b = cell.bbox
                if b.x <= cx <= b.x1 and b.y <= cy <= b.y1:
                    area = (b.x1 - b.x) * (b.y1 - b.y)
                    if area < best_area:
                        containing_cell = cell
                        best_area = area

        if containing_cell is not None and _role_for(containing_cell) == "empty":
            # The cell-first contract owns this region.
            if debug_records is not None:
                debug_records.append({
                    "stage": "underscore_input",
                    "decision": "skip_empty_cell",
                    "orig": u["orig"],
                })
            continue

        label, label_conf = _find_underscore_label(rect, geom.words)
        suffix = u["suffix"]
        is_unit = _is_unit_suffix(suffix)
        display_label = label if _label_has_data(label) else suffix
        grid_col_hdr, grid_row_id = "", ""
        if containing_cell is not None:
            grid_col_hdr, grid_row_id = _grid_label_for_cell(containing_cell)
            if grid_col_hdr and grid_row_id:
                # Determine if the slot sits inside a "value cell" — the
                # cell's only content is a unit-suffix decoration (`mg`,
                # `mL`, `g`, …) sitting next to the underline. In that
                # case the proximity search is meaningless (it would
                # pick up whatever paragraph sits below the table) and
                # the grid headers are the right answer.
                cell_only_text = _cell_text(containing_cell, geom.words).strip()
                cell_is_value_slot = (
                    not cell_only_text
                    or _is_unit_suffix(cell_only_text)
                    or cell_only_text.lower() == suffix.strip().lower()
                )
                proximity_useless = (
                    not _label_has_data(display_label)
                    or _is_unit_suffix(display_label.strip())
                    or display_label.strip().lower() == suffix.strip().lower()
                )
                if cell_is_value_slot or proximity_useless:
                    display_label = grid_col_hdr
                    label_conf = max(label_conf, 0.75)

        if not _label_has_data(display_label):
            if debug_records is not None:
                debug_records.append({
                    "stage": "underscore_input",
                    "decision": "skip_no_label",
                    "orig": u["orig"],
                })
            continue

        right_unit = _unit_word_to_right(rect, geom.words)
        if is_unit or right_unit:
            ftype = "number"
        else:
            ftype = classify_field_type(display_label, keyword_map)

        # Field rect: a writing strip ABOVE the underline baseline, so
        # the bottom of the box sits on the existing underline.
        field_h = 18.0
        field_y = max(0.0, rect.y1 - field_h)
        # Prefer the grid row-id when we've already pulled one — it's
        # the more specific anchor (e.g., "ATX-298"). Fall back to the
        # page-level step label.
        step_row_id = _step_label_at(step_index or [], (rect.y + rect.y1) / 2)
        row_id_out = grid_row_id or step_row_id
        out.append(Suggestion(
            page=geom.page_num,
            kind="underscore_input",
            field_type=ftype,
            x=rect.x,
            y=field_y,
            width=max(24.0, rect.w),
            height=field_h,
            label_text=display_label,
            confidence=0.65 if label_conf >= 0.6 else 0.5,
            from_cell=False,
            label_confidence=label_conf,
            row_id=row_id_out,
            col_header=grid_col_hdr,
        ))
        if debug_records is not None:
            debug_records.append({
                "stage": "underscore_input",
                "decision": "emit",
                "label": display_label,
                "suffix": suffix,
                "ftype": ftype,
                "orig": u["orig"],
            })
    return out


def _emit_nested_table_fields(
    merged_cell: Cell,
    geom: PageGeometry,
    keyword_map: dict[str, list[str]],
    next_table_id: int,
    debug_records: list[dict[str, Any]] | None = None,
    step_index: list[tuple[float, float, str]] | None = None,
) -> tuple[list[Suggestion], int]:
    """Detect a sub-table within a merged cell and emit one field per
    empty value cell.

    Process-step batch records often place a small "label | value" grid
    inside an Instructions cell that spans many rows of the outer
    table. The outer table merges that whole region because the inner
    row dividers don't reach the outer column borders. We rescue the
    sub-grid by re-running table-building on the H/V lines that fall
    inside the merged cell, and emit fields for empty value cells.
    """
    cell_bbox = merged_cell.bbox
    # Collect every V line inside (or touching the boundary of) the
    # merged cell. We deliberately drop the old 40%-of-parent-height
    # threshold here because a merged Instructions cell can host
    # *multiple* sub-tables stacked vertically (e.g., a "Target weight
    # required" 2-col block followed by a "Tare / Gross / Net /
    # Meets Criterion?" 4-col block at the bottom). Each cluster of
    # V lines that share a y-range marks one sub-grid.
    all_inner_v = [
        v for v in geom.v_lines
        if cell_bbox.x - 4 <= v.x <= cell_bbox.x1 + 4
        and v.y0 >= cell_bbox.y - 4
        and v.y1 <= cell_bbox.y1 + 4
        and (v.y1 - v.y0) >= 18.0  # discard tiny stubs that aren't column edges
    ]
    if len(all_inner_v) < 2:
        return [], next_table_id

    # Cluster V lines by their (y0, y1) range — tolerant of small
    # baseline jitter.
    v_clusters: list[list[VLine]] = []
    Y_TOL = 4.0
    for v in sorted(all_inner_v, key=lambda v: (v.y0, v.x)):
        placed = False
        for cluster in v_clusters:
            ref = cluster[0]
            if abs(v.y0 - ref.y0) <= Y_TOL and abs(v.y1 - ref.y1) <= Y_TOL:
                cluster.append(v)
                placed = True
                break
        if not placed:
            v_clusters.append([v])

    out: list[Suggestion] = []
    sub_table_for_cell: dict[int, Table] = {}
    sub_texts_for_table: dict[int, dict[tuple[int, int], str]] = {}

    for cluster in v_clusters:
        # Need at least 3 V lines to form a 2-column sub-grid (left
        # border + 1 inner divider + right border). Two V lines alone
        # is just the parent column's edges, not an inner sub-table.
        if len(cluster) < 3:
            continue
        cluster_y0 = min(v.y0 for v in cluster)
        cluster_y1 = max(v.y1 for v in cluster)
        cluster_x0 = min(v.x for v in cluster)
        cluster_x1 = max(v.x for v in cluster)

        cluster_h = [
            h for h in geom.h_lines
            if cluster_y0 - 2.0 <= h.y <= cluster_y1 + 2.0
            and h.x0 >= cluster_x0 - 6.0
            and h.x1 <= cluster_x1 + 6.0
        ]

        # Synthesise the bottom rule when the sub-table's bottom is
        # shared with the merged cell's bottom border (or just below an
        # H line we already collected). Without this, the last row of
        # the inner grid never closes.
        has_bottom = any(abs(h.y - cluster_y1) <= 2.0 for h in cluster_h)
        if not has_bottom:
            cluster_h.append(HLine(x0=cluster_x0, x1=cluster_x1, y=cluster_y1))
        has_top = any(abs(h.y - cluster_y0) <= 2.0 for h in cluster_h)
        if not has_top:
            cluster_h.append(HLine(x0=cluster_x0, x1=cluster_x1, y=cluster_y0))

        if len(cluster_h) < 2:
            continue

        sub_table = _build_single_grid(
            cluster_h, cluster, table_id=next_table_id,
        )
        if sub_table is None or len(sub_table.cells) < 2:
            continue
        next_table_id += 1

        sub_texts = {
            (c.row, c.col): _cell_text(c, geom.words) for c in sub_table.cells
        }
        sub_table_for_cell[sub_table.id] = sub_table
        sub_texts_for_table[sub_table.id] = sub_texts
        for c in sub_table.cells:
            # Skip the sub-table's narrow seam cells (typical of inset
            # borders that bracket the real cell content).
            if c.bbox.h < 10.0 or c.bbox.w < 16.0:
                continue
            text = sub_texts[(c.row, c.col)]
            words_in_cell = _words_in(geom.words, c.bbox, inset=0.5)
            role = _cell_role(text, words_in_cell)
            if role == "label":
                continue
            # Label = leftmost cell in this sub-row with text. Fall back
            # to the cell directly above (row 0, same column) so a
            # column-header style sub-grid (Tare/Gross/Net/Meets
            # Criterion?) emits something meaningful for the data row.
            label = ""
            for cc in range(0, c.col):
                txt = sub_texts.get((c.row, cc), "")
                if _label_has_data(txt):
                    label = _clean_label(txt)
                    break
            if not _label_has_data(label) and c.row > 0:
                hdr = sub_texts.get((0, c.col), "")
                if _label_has_data(hdr):
                    label = _clean_label(hdr)
            if not _label_has_data(label):
                continue

            if role == "checkbox":
                kind = "nested_cell_checkbox"
                ftype = "checkbox"
            else:
                kind = "nested_cell_input"
                ftype = classify_field_type(label, keyword_map)

            # Inherit the outer step's identifier so the same nested
            # label repeated across many steps (e.g., "Balance ID",
            # "Vessel ID") disambiguates by step instead of "(page N)".
            step_row_id = _step_label_at(
                step_index or [], c.bbox.y + c.bbox.h / 2,
            )
            out.append(Suggestion(
                page=geom.page_num,
                kind=kind,
                field_type=ftype,
                x=c.bbox.x,
                y=c.bbox.y,
                width=c.bbox.w,
                height=c.bbox.h,
                label_text=label,
                confidence=0.7,
                from_cell=True,
                table_id=sub_table.id,
                cell_row=c.row,
                cell_col=c.col,
                label_confidence=0.7,
                row_id=step_row_id,
            ))
            if debug_records is not None:
                debug_records.append({
                    "stage": "nested_cell",
                    "tableId": sub_table.id,
                    "row": c.row, "col": c.col,
                    "decision": "input",
                    "label": label,
                    "fieldType": ftype,
                })
    return out, next_table_id


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
        # Walk DOWNWARD from row 0 so we find the table's real header
        # row before any intermediate data row. We accept a row as the
        # column header only when (a) it has text in our specific column
        # AND (b) at least half its cells carry text overall (filters
        # stray data rows like "Approved : I Yes I No" or
        # "Ingredient A | 25 kg | _ | _"). Walking from the top also
        # prevents an inner data row whose cells happen to contain
        # static markers ("N/A", "—") from masquerading as the header.
        for r in range(0, row):
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


# Labels that name an external identifier whose value is alphanumeric
# (SKUs, lot codes, equipment IDs). Without this override the bare
# "number" / "no." / "id" keywords in the number bucket would misclassify
# every "Lot Number", "Part Number", "Vessel ID", "Pump ID" as numeric.
_TEXT_IDENTIFIER_NUMBER_RE = re.compile(
    r"\b(?:"
    r"lot|part|batch|serial|catalog(?:ue)?|model|sku|product|reference|"
    r"ref|document|doc|order|invoice|po|asset|tag"
    r")\s*(?:no\.?|number|#|code)\b",
    re.IGNORECASE,
)
_TRAILING_ID_RE = re.compile(r"\bid\b\s*(?:[\(:].*)?\s*$", re.IGNORECASE)


def _has_strong_format_hint(label: str) -> bool:
    """True when the label contains an unambiguous date/time format
    literal (`HH:MM`, `DDMMYYYY`, …). Used to override column-level
    type voting from a per-row label."""
    return bool(_TIME_FORMAT_RE.search(label) or _DATE_FORMAT_RE.search(label))


def _looks_like_text_identifier(label: str) -> bool:
    if _TEXT_IDENTIFIER_NUMBER_RE.search(label):
        return True
    # "Balance ID", "Vessel ID", "Pump ID", "Storage Equipment ID" —
    # a noun-modified ID at the end of the label. A bare "ID" alone
    # could go either way; require at least one preceding word.
    if _TRAILING_ID_RE.search(label) and len(label.split()) >= 2:
        return True
    return False


# Format hints that override the multi-word ambiguity guard.
# "Start Date and Time (HH:MM)" otherwise falls to plain text because it
# has 6 words — but the HH:MM literal is unambiguous.
_TIME_FORMAT_RE = re.compile(r"\bhh\s*[:\.]\s*mm\b", re.IGNORECASE)
_DATE_FORMAT_RE = re.compile(
    r"\b(?:ddmmyyyy|mmddyyyy|yyyymmdd|"
    r"dd\s*[/-]\s*mm\s*[/-]\s*(?:yyyy|yy)|"
    r"mm\s*[/-]\s*dd\s*[/-]\s*(?:yyyy|yy)"
    r")\b",
    re.IGNORECASE,
)


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

    # Strong type signals beat the keyword bucket and the ambiguity
    # guard below. Resolve them first.
    if _looks_like_text_identifier(t):
        return "text"
    has_time_fmt = bool(_TIME_FORMAT_RE.search(t))
    has_date_fmt = bool(_DATE_FORMAT_RE.search(t))
    if has_time_fmt and not has_date_fmt:
        return "time"
    if has_date_fmt and not has_time_fmt:
        return "date"
    if has_time_fmt and has_date_fmt:
        # "Start Date and Time (HH:MM)" — both signals present; prefer
        # the more specific (time) since HH:MM is the literal format.
        return "time"

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

    # Synthetic ids assigned to nested sub-tables we recover from
    # merged cells. Counter starts above any real table id.
    nested_table_id_counter = (
        max((t.id for t in geom.tables), default=-1) + 1000
    )

    # Per-page step y-index — feeds row_id into free-floating fields
    # (underscore inputs, nested-table fields) so cross-page collisions
    # disambiguate by step rather than "(page N)".
    step_index = _build_step_index(geom, table_cell_texts)

    for table in geom.tables:
        cell_texts = table_cell_texts[table.id]
        num_cols = len(table.col_bounds) - 1
        injected_headers = (
            (injected_headers_by_table or {}).get(table.id)
        )

        # Table-of-contents and reference blocks are tables in shape only
        # — every cell already holds static text, with no empty cell to
        # the right or below to act as an input slot. Skip the whole
        # table so the form builder isn't littered with bogus fields.
        if _is_informational_table(table, cell_texts, words):
            if debug_records is not None:
                debug_records.append({
                    "stage": "table",
                    "tableId": table.id,
                    "decision": "informational_skip",
                    "rows": len(table.row_bounds) - 1,
                    "cols": num_cols,
                })
            continue

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

        cells_to_emit = _split_tall_empty_cells(table, cell_texts, words)
        for cell in cells_to_emit:
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

            # A merged container cell that *contains* a nested sub-grid
            # with a Yes/No question (e.g., "Tare / Gross / Net / Meets
            # Criterion?  Yes / No" at the bottom of a step's
            # Instructions cell) reads as a checkbox prompt at the top
            # level — but the actual checkbox lives in the inner row.
            # Re-route to the label branch so nested-table emission
            # runs and produces the per-row fields.
            if role == "checkbox" and (cell.row_span > 1 or cell.col_span > 1):
                role = "label"

            if role == "label":
                if debug_records is not None:
                    debug_records.append({
                        "stage": "cell",
                        "tableId": cell.table_id,
                        "row": cell.row, "col": cell.col,
                        "decision": "label",
                        "text": text,
                    })
                # A merged label cell can wrap a nested label/value
                # sub-grid (instructions block + sub-table). Recover
                # those fields from the lines inside the merged cell.
                if cell.row_span > 1 or cell.col_span > 1:
                    nested, nested_next_id = _emit_nested_table_fields(
                        cell, geom, keyword_map, nested_table_id_counter,
                        debug_records=debug_records,
                        step_index=step_index,
                    )
                    out.extend(nested)
                    nested_table_id_counter = nested_next_id
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

            # Step-marker columns ("Step", "#", "No.", "Item") are
            # process identifiers, not inputs. Even when the cells look
            # empty (step numbers often aren't extractable text), the
            # form builder shouldn't get a field per row here.
            effective_header = col_header or column_header_texts.get(cell.col, "")
            if role == "empty" and _is_step_identifier_header(effective_header):
                if debug_records is not None:
                    debug_records.append({
                        "stage": "cell",
                        "tableId": cell.table_id,
                        "row": cell.row, "col": cell.col,
                        "decision": "step_column_skip",
                        "header": effective_header,
                    })
                continue

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
            # Exception: when either the cell's display label or its row
            # id carries an unambiguous format hint (HH:MM, DDMMYYYY, …)
            # and the column vote is the generic "text", trust the
            # row-specific signal so e.g. a "Start time (HH:MM)" cell in
            # an "Instructions" column still reads as time.
            cell_ftype = classify_field_type(
                display_label, keyword_map, geometry_hint=hint,
            )
            # Only trust the row id's *type* when it carries a strong
            # format literal — generic keyword matches (e.g., "pH" inside
            # a buffer-row label) would otherwise flip a "Lot Number"
            # column from text to number.
            row_strong_ftype = (
                classify_field_type(row_id, keyword_map, geometry_hint=hint)
                if row_id and _has_strong_format_hint(row_id) else None
            )
            col_ftype = column_types.get(cell.col)
            if col_ftype and col_ftype != "text":
                ftype = col_ftype
            elif col_ftype == "text" and cell_ftype in {"time", "date", "number"}:
                ftype = cell_ftype
            elif col_ftype == "text" and row_strong_ftype in {"time", "date", "number"}:
                ftype = row_strong_ftype
            else:
                ftype = col_ftype or cell_ftype
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
    # Discard underlines that are actually internal dividers of a
    # text-only standalone box (e.g. the top/middle/bottom rules of a
    # paragraph block surrounded by a border). A divider line spans
    # essentially the full width of its enclosing box; narrower lines
    # inside the same box (Print Name / Signature underlines) remain
    # available as input fields.
    text_only_boxes = [
        b for b in geom.standalone_boxes if not _box_has_input_area(b, words)
    ]
    divider_tol = 4.0

    def _is_box_divider(line: HLine) -> bool:
        for b in text_only_boxes:
            if not (b.y - divider_tol <= line.y <= b.y1 + divider_tol):
                continue
            if (
                abs(line.x0 - b.x) <= divider_tol
                and abs(line.x1 - b.x1) <= divider_tol
            ):
                return True
        return False

    surviving_underlines = [
        u for u in geom.standalone_underlines if not _is_box_divider(u)
    ]
    if debug_records is not None:
        for u in geom.standalone_underlines:
            if _is_box_divider(u):
                debug_records.append({
                    "stage": "standalone_underline",
                    "decision": "box_divider_skip",
                    "y": round(u.y, 1),
                    "x0": round(u.x0, 1),
                    "x1": round(u.x1, 1),
                })
    # Merge vertically-stacked underlines that share an x range (e.g.
    # the multi-line NOTES section) into one free-text block. Lone
    # underlines stay as single-line fields.
    underline_groups = _group_stacked_underlines(surviving_underlines, words)
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
        # Reject bordered text blocks (headings, callouts, paragraph
        # borders): without either an "Label: ___" stub or an empty
        # interior, the box isn't an input zone and shouldn't spawn a
        # field even when there's a nearby phrase that could pose as one.
        if not _box_has_input_area(box, words):
            if debug_records is not None:
                debug_records.append({
                    "stage": "standalone_box",
                    "decision": "text_block_skip",
                    "x": round(box.x, 1), "y": round(box.y, 1),
                    "w": round(box.w, 1), "h": round(box.h, 1),
                })
            continue
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

    # ---- Underscore-text inputs ---------------------------------------
    # Some batch records draw fill-in slots with underscore characters
    # (`_______`, `____mg`, `=____g`) rather than vector rules. Each
    # such run is an independent input; the label is the caption beneath
    # it (or above for signature lines) and the field type is "number"
    # whenever a unit suffix is present.
    out.extend(_emit_underscore_inputs(
        geom, keyword_map, debug_records,
        step_index=step_index,
        table_cell_texts=table_cell_texts,
    ))

    return out
