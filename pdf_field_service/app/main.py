"""FastAPI entrypoint for PDF field detection."""

from __future__ import annotations

import os

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


@app.post("/detect")
async def detect_endpoint(
    pdf: UploadFile = File(...),
    max_pages: int = Form(30),
    include_debug: bool = Form(False),
):
    if not pdf.filename or not pdf.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Expected a PDF file")
    raw = await pdf.read()
    if len(raw) > int(os.environ.get("EBR_PDF_DETECT_MAX_BYTES", str(12 * 1024 * 1024))):
        raise HTTPException(413, "PDF too large")
    if len(raw) < 8 or raw[:4] != b"%PDF":
        raise HTTPException(400, "Invalid PDF payload")
    try:
        mp = max(1, min(max_pages, int(os.environ.get("EBR_PDF_DETECT_MAX_PAGES", "50"))))
        result = detect_pdf(raw, max_pages=mp, include_debug=include_debug)
        return result
    except Exception as e:
        raise HTTPException(500, f"Detection failed: {e!s}") from e
