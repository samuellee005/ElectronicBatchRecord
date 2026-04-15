import { useState, useRef, useEffect, useCallback } from 'react'
import './PdfZoomControls.css'

function parsePercentToScale(raw, minScale, maxScale) {
  const t = String(raw ?? '')
    .trim()
    .replace(/%/g, '')
    .replace(/,/g, '.')
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return null
  const scale = n / 100
  return Math.min(maxScale, Math.max(minScale, scale))
}

/**
 * Zoom − / + / Reset with optional direct % entry (double-click the percentage).
 */
export default function PdfZoomControls({
  scale,
  onScaleChange,
  minScale = 0.5,
  maxScale = 3,
  defaultScale = 1.5,
  className = '',
  resetIcon = false,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)
  const percent = Math.round(scale * 100)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    const next = parsePercentToScale(draft, minScale, maxScale)
    setEditing(false)
    if (next != null) onScaleChange(next)
  }, [draft, minScale, maxScale, onScaleChange])

  const cancel = useCallback(() => {
    setEditing(false)
    setDraft('')
  }, [])

  const zoomIn = () => onScaleChange(Math.min(scale + 0.25, maxScale))
  const zoomOut = () => onScaleChange(Math.max(scale - 0.25, minScale))
  const reset = () => onScaleChange(defaultScale)

  const startEdit = () => {
    setDraft(String(percent))
    setEditing(true)
  }

  return (
    <div className={`pdf-zoom-controls ${className}`.trim()}>
      <button type="button" onClick={zoomOut} title="Zoom out">
        &minus;
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="pdf-zoom-controls-input"
          type="text"
          inputMode="decimal"
          aria-label="Zoom percentage"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        />
      ) : (
        <span
          className="pdf-zoom-controls-percent"
          title="Double-click to type zoom %"
          onDoubleClick={startEdit}
        >
          {percent}%
        </span>
      )}
      <button type="button" onClick={zoomIn} title="Zoom in">
        +
      </button>
      <button
        type="button"
        onClick={reset}
        title="Reset zoom"
        aria-label="Reset zoom"
      >
        {resetIcon ? '\u21bb' : 'Reset'}
      </button>
    </div>
  )
}
