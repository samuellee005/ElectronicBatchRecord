"""Public entry point for the PDF field detection service.

The pipeline:

    Stage A (geometry.py)  → find tables, cells, underlines, boxes, checkboxes
    Stage B (fields.py)    → classify cells, emit ONE field per input-cell
    Stage C (fields.py)    → associate labels (row + column headers)
    Stage D (fields.py)    → pick field type from label + geometry hints

The response shape is preserved for the PHP glue and frontend ingestion
(see `frontend/src/utils/pdfDesignCoords.js`).
"""

from __future__ import annotations

import collections
import io
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import cv2
import fitz  # PyMuPDF
import numpy as np

try:
    import pytesseract
except ImportError:
    pytesseract = None

from . import fields as _fields
from . import geometry as _geometry
from .fields import Suggestion  # re-exported for callers
from .geometry import Rect


# ---------- Configuration ------------------------------------------------ #


@lru_cache(maxsize=1)
def _load_field_type_keywords() -> dict[str, list[str]]:
    """Load keyword-to-field-type mapping from config; fall back to defaults."""
    cfg_path = Path(__file__).resolve().parent / "config" / "field_type_keywords.json"
    try:
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("field_type_keywords.json must contain an object")
        out: dict[str, list[str]] = {}
        for k, v in raw.items():
            if isinstance(v, list):
                vals = [str(s).strip().lower() for s in v if str(s).strip()]
                if vals:
                    out[str(k).strip().lower()] = vals
        for ftype, defaults in _fields.DEFAULT_FIELD_TYPE_KEYWORDS.items():
            out.setdefault(ftype, defaults)
        return out
    except Exception:
        return dict(_fields.DEFAULT_FIELD_TYPE_KEYWORDS)


def _classify_from_label(text: str) -> str:
    """Backwards-compatible helper used by older tests."""
    return _fields.classify_field_type(text, _load_field_type_keywords())


# ---------- OCR fallback for scans -------------------------------------- #


def _ocr_words(page: fitz.Page, gray: np.ndarray) -> list[tuple[float, float, float, float, str]]:
    """Run Tesseract on a rendered page when PyMuPDF returns no embedded text."""
    if pytesseract is None:
        return []
    if gray is None or gray.size == 0:
        return []
    h, w = gray.shape[:2]
    try:
        _, buf = cv2.imencode(".png", gray)
        from PIL import Image
        im = Image.open(io.BytesIO(buf.tobytes()))
        data = pytesseract.image_to_data(im, output_type=pytesseract.Output.DICT)
    except Exception:
        return []
    words: list[tuple[float, float, float, float, str]] = []
    n = len(data.get("text", []))
    pw, ph = float(page.rect.width), float(page.rect.height)
    sx = pw / max(1, w)
    sy = ph / max(1, h)
    for i in range(n):
        t = (data["text"][i] or "").strip()
        if not t or int(data["conf"][i] or 0) < 30:
            continue
        lx, ly, lw, lh = (
            int(data["left"][i]),
            int(data["top"][i]),
            int(data["width"][i]),
            int(data["height"][i]),
        )
        words.append((lx * sx, ly * sy, (lx + lw) * sx, (ly + lh) * sy, t))
    return words


# ---------- Output assembly --------------------------------------------- #


def _clamp_to_page(s: Suggestion, page_w: float, page_h: float) -> Suggestion:
    """Force the field rect to lie inside the page bounds."""
    x = max(0.0, min(s.x, page_w - 1.0))
    y = max(0.0, min(s.y, page_h - 1.0))
    w = max(4.0, min(s.width, page_w - x))
    h = max(4.0, min(s.height, page_h - y))
    s.x = x
    s.y = y
    s.width = w
    s.height = h
    return s


def _tag_repeating_row_tables(suggestions: list[Suggestion]) -> None:
    """Mark suggestions that came from a homogeneous repeating-row table.

    A repeating-row table has *anonymous* rows — they're just a sequence
    of empty rows under a single header (UFDF pressure logs, fill-check
    tare/gross/net rows, operator identification grids, documentation
    comment lines). Rows in a BoM or Equipment table are NOT anonymous:
    each carries a distinct material/equipment name as `row_id`, and
    those should be left alone.

    Heuristic: within one (page, tableId), find columns where the same
    `col_header` (or label fallback) repeats across ≥4 rows AND those
    rows have no meaningful `row_id` (empty, or all sharing a single
    value). When such a column exists, flag every suggestion in the
    table with `repeating=True`, a shared `repeat_group_id`
    (`tbl_<id>_p<page>`), a row index, and the total rows observed —
    the frontend can collapse them into one "+ Add row" widget.
    """
    by_table: dict[tuple[int, int], list[Suggestion]] = collections.defaultdict(list)
    for s in suggestions:
        if s.table_id is None or s.cell_col is None:
            continue
        by_table[(s.page, s.table_id)].append(s)

    for (page, table_id), members in by_table.items():
        if len(members) < 4:
            continue
        col_groups: dict[tuple[int, str], list[Suggestion]] = collections.defaultdict(list)
        for s in members:
            key = (s.cell_col or 0, (s.col_header or s.label_text).strip())
            col_groups[key].append(s)
        # A column qualifies as a repeating axis when (a) it has ≥4
        # entries and (b) their row_ids are anonymous — empty, or every
        # cell shares a single id (no per-row distinction).
        def _anonymous(group: list[Suggestion]) -> bool:
            row_ids = {(s.row_id or "").strip() for s in group}
            row_ids.discard("")
            return len(row_ids) <= 1
        repeating_cols = [
            g for g in col_groups.values()
            if len(g) >= 4 and _anonymous(g)
        ]
        if not repeating_cols:
            continue
        rows_observed = max(len(g) for g in repeating_cols)
        group_id = f"tbl_{table_id}_p{page}"
        members_sorted = sorted(members, key=lambda x: (x.cell_row or 0, x.cell_col or 0))
        seen_rows: dict[int, int] = {}
        for s in members_sorted:
            row = s.cell_row or 0
            if row not in seen_rows:
                seen_rows[row] = len(seen_rows)
            s.repeating = True
            s.repeat_group_id = group_id
            s.repeat_row_index = seen_rows[row]
            s.repeat_rows_observed = rows_observed


def _disambiguate_labels(suggestions: list[Suggestion]) -> None:
    """Ensure every suggestion in the document has a label distinct from
    every other suggestion's label.

    Goal: when the user saves a form, no two fields share the same
    display name — e.g. a Bill of Materials table with 13 "Lot Number"
    cells should produce "Lot Number — Ultrapure water",
    "Lot Number — 200 proof Ethanol", … instead of thirteen identical
    "Lot Number" entries.

    Three passes:
      1. Semantic — use row_id / col_header on collisions so each cell
         picks up its row's identifier.
      2. Cross-page — append "(page N)" for labels that still collide
         across multiple pages.
      3. Numeric — append "#1/#2/..." (ordered top-to-bottom) for any
         remaining duplicates within a page.
    """
    if len(suggestions) <= 1:
        return

    def _specific(s: Suggestion) -> str | None:
        base = s.label_text
        if s.row_id and s.col_header and s.col_header.strip() == base.strip():
            return f"{base} — {s.row_id}"
        if s.row_id and s.row_id.strip() != base.strip():
            return f"{base} — {s.row_id}"
        if s.col_header and s.col_header.strip() != base.strip():
            return f"{s.col_header} — {base}"
        return None

    # Pass 1: semantic disambiguation for collisions.
    counts = collections.Counter(s.label_text for s in suggestions)
    for s in suggestions:
        if counts[s.label_text] > 1:
            cand = _specific(s)
            if cand and cand != s.label_text:
                s.label_text = cand

    # Pass 2: append page number when a label still spans multiple pages.
    pages_per_label: dict[str, set[int]] = collections.defaultdict(set)
    for s in suggestions:
        pages_per_label[s.label_text].add(s.page)
    for s in suggestions:
        if len(pages_per_label[s.label_text]) > 1:
            s.label_text = f"{s.label_text} (page {s.page})"

    # Pass 3: numeric suffix for any in-page duplicates that remain.
    groups: dict[str, list[Suggestion]] = collections.defaultdict(list)
    for s in suggestions:
        groups[s.label_text].append(s)
    for label, group in groups.items():
        if len(group) <= 1:
            continue
        group.sort(key=lambda x: (x.page, x.y, x.x))
        for i, s in enumerate(group, start=1):
            s.label_text = f"{label} #{i}"


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(label: str) -> str:
    """Convert a free-form label into a snake_case identifier.

    Lowercases, replaces any run of non-alphanumeric ASCII with a
    single underscore, trims leading/trailing underscores, and falls
    back to ``"field"`` when the label has no alphanumeric content.
    """
    base = _SLUG_RE.sub("_", (label or "").lower()).strip("_")
    return base or "field"


def _assign_machine_names(suggestions: list[Suggestion]) -> None:
    """Give every suggestion a unique snake_case ``name`` derived from
    its (already-disambiguated) label.

    The display label keeps any disambiguation context (em-dash, "#N",
    "(page N)") so the resulting slug naturally inherits that context —
    e.g. ``"Lot Number — Ultrapure water"`` →
    ``lot_number_ultrapure_water``. In the rare event two labels
    collapse to the same slug after non-alphanumeric removal we append
    ``_2``, ``_3``, …
    """
    if not suggestions:
        return
    seen: set[str] = set()
    for s in suggestions:
        base = _slugify(s.label_text)
        candidate = base
        n = 2
        while candidate in seen:
            candidate = f"{base}_{n}"
            n += 1
        seen.add(candidate)
        s.name = candidate


def _suggestion_to_dict(idx: int, s: Suggestion) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": f"det_{idx}",
        "page": s.page,
        "kind": s.kind,
        "fieldType": s.field_type,
        "x": round(s.x, 2),
        "y": round(s.y, 2),
        "width": round(s.width, 2),
        "height": round(s.height, 2),
        "labelText": s.label_text,
        "name": s.name,
        "confidence": round(s.confidence, 3),
        "fromCell": s.from_cell,
    }
    if s.table_id is not None:
        out["tableId"] = s.table_id
        out["cellRow"] = s.cell_row
        out["cellCol"] = s.cell_col
    if s.label_confidence:
        out["labelConfidence"] = round(s.label_confidence, 3)
    if s.row_id:
        out["rowId"] = s.row_id
    if s.col_header:
        out["colHeader"] = s.col_header
    if s.repeating:
        out["repeating"] = True
        out["repeatGroupId"] = s.repeat_group_id
        out["repeatRowIndex"] = s.repeat_row_index
        out["repeatRowsObserved"] = s.repeat_rows_observed
    return out


# ---------- Cross-page header carry (Fix #1) ---------------------------- #


def _table_headers_for_carry(
    table: _geometry.Table,
    cell_texts: dict[tuple[int, int], str],
) -> dict[int, str] | None:
    """Return the table's column header texts when row 0 looks like a header.

    Used to remember headers from page N so that page N+1's continuation
    table (same column layout, no header row of its own) can inherit them.
    """
    num_cols = len(table.col_bounds) - 1
    if num_cols < 2:
        return None
    row0 = [cell_texts.get((0, c), "") for c in range(num_cols)]
    filled = sum(1 for t in row0 if t and any(ch.isalnum() for ch in t))
    if filled < max(2, num_cols // 2):
        return None
    return {c: row0[c].strip() for c in range(num_cols) if row0[c]}


def _col_bounds_match(a: list[float], b: list[float], tol: float = 6.0) -> bool:
    """True when two tables share the same column layout (within tolerance)."""
    if len(a) != len(b):
        return False
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def _resolve_header_carry(
    geom: _geometry.PageGeometry,
    cell_texts_by_table: dict[int, dict[tuple[int, int], str]],
    header_memory: list[dict[str, Any]],
) -> dict[int, dict[int, str]]:
    """For each table on this page that has no header row, find a matching
    table from an earlier page and inherit its column headers.

    `header_memory` is mutated to record this page's labelled-row-0 tables
    so the next page can inherit from them in turn.
    """
    injected: dict[int, dict[int, str]] = {}
    for table in geom.tables:
        cell_texts = cell_texts_by_table[table.id]
        own_headers = _table_headers_for_carry(table, cell_texts)
        if own_headers:
            # This table is itself a header source for downstream pages.
            header_memory.append({
                "page": geom.page_num,
                "col_bounds": list(table.col_bounds),
                "headers": own_headers,
            })
            continue
        # No header row on this table — look back for a match.
        for entry in reversed(header_memory):
            if entry["page"] >= geom.page_num:
                continue
            if _col_bounds_match(entry["col_bounds"], table.col_bounds):
                injected[table.id] = dict(entry["headers"])
                # This continuation also acts as a forward source so a
                # 3-page log keeps its headers across all continuations.
                header_memory.append({
                    "page": geom.page_num,
                    "col_bounds": list(table.col_bounds),
                    "headers": dict(entry["headers"]),
                })
                break
    return injected


# ---------- Public entry point ----------------------------------------- #


def detect_pdf(
    pdf_bytes: bytes,
    max_pages: int = 30,
    render_zoom: float = 2.0,
    include_debug: bool = False,
) -> dict[str, Any]:
    """Detect form fields in a PDF and return suggestions for the UI.

    Args:
        pdf_bytes: Raw PDF binary.
        max_pages: Soft cap on how many pages to scan (defaults to 30).
        render_zoom: Raster zoom for OpenCV fallback (only used when the
            PDF lacks vector borders).
        include_debug: Adds `debug.pages[*].tables/decisions` for the
            upload-time overlay.

    Returns:
        ``{ success, pagesAnalyzed, pageCount, warnings, suggestions[, debug] }``
    """
    warnings: list[str] = []
    debug_pages: list[dict[str, Any]] = []
    keyword_map = _load_field_type_keywords()

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        total_pages = len(doc)
        n = min(total_pages, max(1, max_pages))
        if total_pages > n:
            warnings.append(
                f"Only first {n} of {total_pages} pages analyzed; raise "
                f"the page cap to process the remainder."
            )
        all_sug: list[Suggestion] = []
        # Cross-page header memory (Fix #1).
        header_memory: list[dict[str, Any]] = []
        for i in range(n):
            try:
                page = doc[i]
                pw, ph = float(page.rect.width), float(page.rect.height)

                # Render once — needed for the raster fallbacks inside geometry.
                mat = fitz.Matrix(render_zoom, render_zoom)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                if pix.n == 4:
                    gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
                elif pix.n == 3:
                    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
                else:
                    gray = np.squeeze(img)

                # Embedded text first; OCR fallback when sparse.
                page_words = _geometry._words(page)
                if len(page_words) < 8 and pytesseract is not None:
                    ocr_words = _ocr_words(page, gray)
                    if len(ocr_words) > len(page_words):
                        page_words = ocr_words
                        warnings.append(f"Page {i + 1}: used OCR fallback for sparse text.")

                geom = _geometry.extract_page_geometry(
                    page, gray, pw, ph, page_num=i + 1, words_override=page_words
                )

                # Build cell-text index for header-carry analysis.
                cell_texts_by_table: dict[int, dict[tuple[int, int], str]] = {}
                for table in geom.tables:
                    d: dict[tuple[int, int], str] = {}
                    for cell in table.cells:
                        d[(cell.row, cell.col)] = _fields._cell_text(cell, geom.words)
                    cell_texts_by_table[table.id] = d
                injected_headers = _resolve_header_carry(
                    geom, cell_texts_by_table, header_memory,
                )

                debug_records: list[dict[str, Any]] | None = [] if include_debug else None
                page_sug = _fields.emit_page_fields(
                    geom, keyword_map,
                    debug_records=debug_records,
                    injected_headers_by_table=injected_headers,
                )
                page_sug = [_clamp_to_page(s, pw, ph) for s in page_sug]

                all_sug.extend(page_sug)

                if include_debug:
                    page_debug = _geometry.page_geometry_to_debug(geom)
                    page_debug["decisions"] = debug_records or []
                    if injected_headers:
                        page_debug["injectedHeaders"] = {
                            str(tid): hdrs for tid, hdrs in injected_headers.items()
                        }
                    debug_pages.append(page_debug)
            except Exception as page_err:
                # Record the failure and keep going — one malformed page
                # shouldn't kill detection for the remaining N-1 pages
                # in a long batch record.
                warnings.append(f"Page {i + 1}: skipped ({page_err!s}).")

        _tag_repeating_row_tables(all_sug)
        _disambiguate_labels(all_sug)
        _assign_machine_names(all_sug)
        out = [_suggestion_to_dict(idx, s) for idx, s in enumerate(all_sug)]
        payload: dict[str, Any] = {
            "success": True,
            "pagesAnalyzed": n,
            "pageCount": len(doc),
            "warnings": warnings[:20],
            "suggestions": out,
        }
        if include_debug:
            payload["debug"] = {"pages": debug_pages}
        return payload
    finally:
        doc.close()
