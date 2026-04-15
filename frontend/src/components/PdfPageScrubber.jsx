import './PdfPageScrubber.css'

/**
 * Range slider + page caption. Place between PdfViewer pagination Previous/Next via paginationScrubber.
 */
export default function PdfPageScrubber({
  currentPage,
  totalPages,
  onGoToPage,
  className = '',
}) {
  if (totalPages <= 1) return null

  const go = (p) => {
    const next = Math.max(1, Math.min(totalPages, p))
    if (next !== currentPage) onGoToPage(next)
  }

  return (
    <div className={`pdf-page-scrubber-wrap ${className}`.trim()}>
      <input
        type="range"
        className="pdf-page-scrubber-range"
        min={1}
        max={totalPages}
        step={1}
        value={currentPage}
        onChange={(e) => go(Number(e.target.value))}
        aria-label={`Page slider, page ${currentPage} of ${totalPages}`}
        aria-valuemin={1}
        aria-valuemax={totalPages}
        aria-valuenow={currentPage}
      />
      <span className="pdf-page-scrubber-caption">
        Page {currentPage} of {totalPages}
      </span>
    </div>
  )
}
