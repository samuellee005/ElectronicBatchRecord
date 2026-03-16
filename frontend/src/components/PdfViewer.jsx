import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

const PdfViewer = forwardRef(function PdfViewer({ pdfUrl, scale = 1.5, onPageRendered, children, paginationPosition = 'bottom', paginationOverlay = false, zoomControls, hidePagination = false }, ref) {
  const containerRef = useRef(null)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useImperativeHandle(ref, () => ({
    getCurrentPage: () => currentPage,
    getTotalPages: () => numPages,
    getCanvasSize: () => canvasSize,
    changePage: (delta) => {
      const next = currentPage + delta
      if (next >= 1 && next <= numPages) setCurrentPage(next)
    },
  }))

  const onLoadSuccess = useCallback(({ numPages: n }) => {
    setNumPages(n)
    setCurrentPage(1)
    setLoading(false)
    setError(null)
  }, [])

  const onLoadError = useCallback((err) => {
    setError(err?.message || 'Failed to load PDF')
    setLoading(false)
  }, [])

  const onRenderSuccess = useCallback(() => {
    const canvas = containerRef.current?.querySelector('canvas')
    if (canvas) {
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      setCanvasSize({ width: w, height: h })
      onPageRendered?.({ page: currentPage, totalPages: numPages, width: w, height: h })
    }
  }, [currentPage, numPages, onPageRendered])

  useEffect(() => {
    setCanvasSize((prev) => (prev.width ? { width: 0, height: 0 } : prev))
  }, [currentPage])

  useEffect(() => {
    if (pdfUrl) {
      setLoading(true)
      setError(null)
      setCurrentPage(1)
      setCanvasSize({ width: 0, height: 0 })
    }
  }, [pdfUrl])

  if (!pdfUrl) return null

  if (error) return <div className="error-message">Error loading PDF: {error}</div>

  const paginationMarkup = (
    <div className="pdf-pagination" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
      <button type="button" disabled={currentPage === 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>Previous</button>
      <span>Page {currentPage} of {numPages}</span>
      <button type="button" disabled={currentPage === numPages} onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}>Next</button>
    </div>
  )

  const showPaginationTop = !hidePagination && numPages > 1 && (paginationPosition === 'top' || paginationPosition === 'both')
  const showPaginationBottom = !hidePagination && numPages > 1 && (paginationPosition === 'bottom' || paginationPosition === 'both')
  const renderPaginationOutside = !paginationOverlay

  return (
    <div className="pdf-viewer-wrapper">
      {renderPaginationOutside && showPaginationTop && <div style={{ marginBottom: 16 }}>{paginationMarkup}</div>}
      <div className="pdf-canvas-wrapper" style={{ position: 'relative', background: 'white', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', display: 'inline-block' }}>
        {/* Zoom overlay: top right */}
        {zoomControls && (
          <div className="pdf-overlay pdf-overlay-zoom" style={{ position: 'absolute', top: 12, right: 12, zIndex: 20, pointerEvents: 'auto' }}>
            {zoomControls}
          </div>
        )}
        {/* Pagination overlay: top center and bottom center */}
        {paginationOverlay && showPaginationTop && (
          <div className="pdf-overlay pdf-overlay-pagination-top" style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 20, pointerEvents: 'auto' }}>
            {paginationMarkup}
          </div>
        )}
        {paginationOverlay && showPaginationBottom && (
          <div className="pdf-overlay pdf-overlay-pagination-bottom" style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 20, pointerEvents: 'auto' }}>
            {paginationMarkup}
          </div>
        )}
        <div ref={containerRef} className="pdf-page-container" style={{ position: 'relative' }}>
          <Document
            file={pdfUrl}
            onLoadSuccess={onLoadSuccess}
            onLoadError={onLoadError}
            loading={
              <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>Loading PDF...</div>
            }
          >
            <Page
              pageNumber={currentPage}
              scale={scale}
              onRenderSuccess={onRenderSuccess}
              loading={null}
            />
          </Document>
          {canvasSize.width > 0 && canvasSize.height > 0 && (
            <div
              className="overlay-layer"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: canvasSize.width,
                height: canvasSize.height,
                pointerEvents: 'auto',
                zIndex: 10,
              }}
            >
              {children}
            </div>
          )}
        </div>
      </div>
      {renderPaginationOutside && showPaginationBottom && <div style={{ marginTop: 16 }}>{paginationMarkup}</div>}
    </div>
  )
})

export default PdfViewer
