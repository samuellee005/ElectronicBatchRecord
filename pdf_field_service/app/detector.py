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

import io
import json
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
        n = min(len(doc), max(1, max_pages))
        all_sug: list[Suggestion] = []
        # Cross-page header memory (Fix #1).
        header_memory: list[dict[str, Any]] = []
        for i in range(n):
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
