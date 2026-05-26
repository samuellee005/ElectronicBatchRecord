"""FastAPI entrypoint for PDF field detection."""

from __future__ import annotations

import os

import fitz  # PyMuPDF — used for the pre-flight page count
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .detector import detect_pdf

app = FastAPI(title="EBR PDF Field Detection", version="1.0.0")

_origins = os.environ.get("EBR_PDF_DETECT_CORS", "*").strip()
_origins_list = [o.strip() for o in _origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins_list if _origins_list != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    """So opening http://host:8000/ in a browser is not an empty 404."""
    return {
        "ok": True,
        "service": "pdf-field-detect",
        "health": "/health",
        "detect": "POST /detect (multipart form field name: pdf)",
    }


@app.get("/health")
def health():
    return {"ok": True, "service": "pdf-field-detect"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@app.post("/detect")
async def detect_endpoint(
    pdf: UploadFile = File(...),
    max_pages: int = Form(500),
    include_debug: bool = Form(False),
    allow_extended_pages: bool = Form(False),
):
    if not pdf.filename or not pdf.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Expected a PDF file")
    raw = await pdf.read()
    byte_cap = _env_int("EBR_PDF_DETECT_MAX_BYTES", 50 * 1024 * 1024)
    if len(raw) > byte_cap:
        raise HTTPException(413, "PDF too large")
    if len(raw) < 8 or raw[:4] != b"%PDF":
        raise HTTPException(400, "Invalid PDF payload")

    # Default cap = 500 pages; explicit user opt-in lifts it to 1000.
    default_cap = _env_int("EBR_PDF_DETECT_MAX_PAGES", 500)
    extended_cap = _env_int("EBR_PDF_DETECT_MAX_PAGES_EXTENDED", 1000)
    active_cap = extended_cap if allow_extended_pages else default_cap

    # Pre-flight: count pages so we can ask the caller for confirmation
    # before doing minutes of work on a doc that exceeds the regular cap.
    try:
        with fitz.open(stream=raw, filetype="pdf") as preflight_doc:
            page_count = len(preflight_doc)
    except Exception as e:
        raise HTTPException(400, f"Could not open PDF: {e!s}") from e

    if page_count > default_cap and not allow_extended_pages:
        return {
            "success": False,
            "requiresConfirmation": True,
            "pageCount": page_count,
            "cap": default_cap,
            "extendedCap": extended_cap,
            "message": (
                f"This PDF has {page_count} pages, which is above the "
                f"{default_cap}-page automatic limit. Confirm to analyze up "
                f"to {extended_cap} pages (this may take several minutes)."
            ),
        }

    mp = max(1, min(max_pages, active_cap))
    try:
        result = detect_pdf(raw, max_pages=mp, include_debug=include_debug)
        return result
    except Exception as e:
        raise HTTPException(500, f"Detection failed: {e!s}") from e
