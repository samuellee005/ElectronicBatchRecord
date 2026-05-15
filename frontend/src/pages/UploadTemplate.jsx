import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { pdfjs } from 'react-pdf'
import { uploadTemplate, detectPdfFields } from '../api/client'
import FieldPreview from '../components/forms/FieldPreview'
import PdfViewer from '../components/PdfViewer'
import {
  suggestionsToFormFields,
  buildFieldFromSuggestion,
  EBR_PENDING_SUGGESTIONS_KEY,
} from '../utils/pdfDesignCoords'
import './FormBuilder.css'
import './UploadTemplate.css'

const DESIGN_SCALE = 1.5

export default function UploadTemplate() {
  const navigate = useNavigate()
  const [file, setFile] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [detectLoading, setDetectLoading] = useState(false)
  const [detectError, setDetectError] = useState(null)
  const [detectInfo, setDetectInfo] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [enabledIds, setEnabledIds] = useState(() => new Set())
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [currentPage, setCurrentPage] = useState(1)
  const [uploadedFilename, setUploadedFilename] = useState(null)
  const [detectDebugEnabled, setDetectDebugEnabled] = useState(false)
  const fileBufferRef = useRef(null)

  useEffect(() => {
    try {
      if (localStorage.getItem('ebrDetectDebug') === '1') setDetectDebugEnabled(true)
    } catch {
      // no-op
    }
  }, [])

  useEffect(() => {
    if (!file) {
      setPdfUrl(null)
      fileBufferRef.current = null
      return
    }
    const url = URL.createObjectURL(file)
    setPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const runDetection = useCallback(async (f) => {
    setDetectLoading(true)
    setDetectError(null)
    setDetectInfo(null)
    setSuggestions([])
    setEnabledIds(new Set())
    try {
      const buf = await f.arrayBuffer()
      fileBufferRef.current = buf
      const data = await detectPdfFields(f, { includeDebug: detectDebugEnabled })
      const list = data.suggestions || []
      setSuggestions(list)
      setEnabledIds(new Set(list.map((s) => s.id)))
      setDetectInfo({
        pagesAnalyzed: data.pagesAnalyzed,
        pageCount: data.pageCount,
        warnings: data.warnings || [],
        debug: data.debug || null,
      })
    } catch (e) {
      fileBufferRef.current = null
      setDetectError(e.message || 'Detection failed')
      if (e.code === 'detect_service_unconfigured') {
        setDetectError(
          `${e.message} For local dev run the Python service (see pdf_field_service/) and set EBR_PDF_DETECT_URL.`,
        )
      }
    } finally {
      setDetectLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!file) return
    runDetection(file)
  }, [file, runDetection])

  const toggleSuggestion = (id) => {
    setEnabledIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const scaleFactor = 1

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!file) return
    setLoading(true)
    setError(null)
    setMessage(null)
    setUploadedFilename(null)
    try {
      const data = await uploadTemplate(file)
      setMessage('PDF uploaded successfully.')
      setUploadedFilename(data.filename || null)
    } catch (err) {
      setError(err.message || 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  const openFormBuilderWithSuggestions = async () => {
    if (!uploadedFilename) return
    const buf = fileBufferRef.current
    const enabled = suggestions.filter((s) => enabledIds.has(s.id))
    if (enabled.length === 0 || !buf) {
      sessionStorage.removeItem(EBR_PENDING_SUGGESTIONS_KEY)
      navigate(`/forms/builder?file=${encodeURIComponent(uploadedFilename)}`)
      return
    }
    try {
      const fields = await suggestionsToFormFields(buf, enabled)
      sessionStorage.setItem(
        EBR_PENDING_SUGGESTIONS_KEY,
        JSON.stringify({ v: 1, pdfFilename: uploadedFilename, fields }),
      )
    } catch {
      sessionStorage.removeItem(EBR_PENDING_SUGGESTIONS_KEY)
    }
    navigate(`/forms/builder?file=${encodeURIComponent(uploadedFilename)}`)
  }

  const fieldStyle = (s) => ({
    left: s._design?.x * scaleFactor,
    top: s._design?.y * scaleFactor,
    width: s._design?.width * scaleFactor,
    height: s._design?.height * scaleFactor,
    pointerEvents: 'none',
    boxSizing: 'border-box',
    overflow: 'hidden',
    borderColor: enabledIds.has(s.id) ? '#667eea' : '#94a3b8',
    opacity: enabledIds.has(s.id) ? 1 : 0.55,
  })

  const [designById, setDesignById] = useState({})

  useEffect(() => {
    let cancelled = false
    if (!suggestions.length || !fileBufferRef.current) {
      setDesignById({})
      return
    }
    ;(async () => {
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
      }
      const pdf = await pdfjs.getDocument({ data: fileBufferRef.current }).promise
      const map = {}
      for (const s of suggestions) {
        if (cancelled) return
        const page = await pdf.getPage(s.page)
        const vp = page.getViewport({ scale: DESIGN_SCALE })
        // Detector emits top-left origin; pdf.js expects bottom-left.
        const pageH = page.view[3] - page.view[1]
        const tl = vp.convertToViewportPoint(s.x, pageH - s.y)
        const br = vp.convertToViewportPoint(s.x + s.width, pageH - (s.y + s.height))
        map[s.id] = {
          x: Math.min(tl[0], br[0]),
          y: Math.min(tl[1], br[1]),
          width: Math.max(2, Math.abs(br[0] - tl[0])),
          height: Math.max(2, Math.abs(br[1] - tl[1])),
        }
      }
      if (!cancelled) setDesignById(map)
    })()
    return () => {
      cancelled = true
    }
  }, [suggestions])

  const onPageRendered = useCallback(({ page, width, height }) => {
    setCurrentPage(page)
    setCanvasSize({ width, height })
  }, [])

  return (
    <div className="page-content upload-page">
      <h1 className="page-title">Upload new template</h1>
      <p className="upload-lead">
        Choose a manufacturing batch record PDF. The server runs automatic field detection (fill lines,
        table cells, checkboxes, signature areas) when the detection service is enabled. Review overlays,
        then upload and open the form builder to place those fields on the template.
      </p>
      {message && <div className="message success">{message}</div>}
      {error && <div className="message error">{error}</div>}
      {detectError && <div className="message error">{detectError}</div>}

      <form className="upload-form" onSubmit={handleSubmit}>
        <p className="upload-step-hint">
          Step 1 — pick a PDF. Detection runs automatically. Step 2 — review suggested fields. Step 3 —
          upload, then continue to the form builder.
        </p>
        <label className="upload-debug-flag">
          <input
            type="checkbox"
            checked={detectDebugEnabled}
            onChange={(e) => {
              const enabled = e.target.checked
              setDetectDebugEnabled(enabled)
              try {
                if (enabled) localStorage.setItem('ebrDetectDebug', '1')
                else localStorage.removeItem('ebrDetectDebug')
              } catch {
                // no-op
              }
              if (file) runDetection(file)
            }}
          />
          Include detector debug info
        </label>
        <div className="upload-file-row">
          <label htmlFor="pdf_file" className="upload-field-label">
            Choose PDF template
          </label>
          <input
            id="pdf_file"
            name="pdf_file"
            type="file"
            accept="application/pdf,.pdf,application/x-pdf"
            required
            onChange={(e) => {
              const f = e.target.files?.[0] || null
              setFile(f)
              setMessage(null)
              setError(null)
              setUploadedFilename(null)
            }}
            className="upload-file-input"
          />
        </div>
        {file && <div className="file-name">Selected: {file.name}</div>}
        {detectLoading && <div className="upload-detect-status">Analyzing PDF layout…</div>}
        {detectInfo && !detectLoading && (
          <div className="upload-detect-meta">
            Analyzed {detectInfo.pagesAnalyzed} page(s)
            {detectInfo.pageCount != null ? ` of ${detectInfo.pageCount}` : ''}.{' '}
            {suggestions.length} suggestion(s).
            {detectInfo.warnings?.length > 0 && (
              <span className="upload-detect-warn"> ({detectInfo.warnings.join(' ')})</span>
            )}
            {detectInfo.debug?.pages?.length > 0 && (
              <details className="upload-detect-debug">
                <summary>
                  Debug: {detectInfo.debug.pages.length} page record(s), table decisions{' '}
                  {detectInfo.debug.pages.reduce((n, p) => n + (p.tableDecisions?.length || 0), 0)}
                </summary>
                <div className="upload-detect-debug-body">
                  {detectInfo.debug.pages.slice(0, 2).map((p) => (
                    <div key={p.page}>
                      p.{p.page}: {(p.tableDecisions || []).slice(0, 4).map((d) => d.reason).join(', ')}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
        <button type="submit" className="upload-btn" disabled={!file || loading}>
          {loading ? 'Uploading…' : 'Upload PDF to server'}
        </button>
      </form>

      {pdfUrl && file && (
        <div className="upload-preview-block">
          <h2 className="upload-preview-title">Preview &amp; suggested fields</h2>
          <div className="upload-preview-layout">
            <div className="upload-preview-pdf">
              <PdfViewer
                pdfUrl={pdfUrl}
                scale={DESIGN_SCALE}
                onPageRendered={onPageRendered}
                hidePagination={false}
              >
                {canvasSize.width > 0 &&
                  suggestions
                    .filter((s) => s.page === currentPage)
                    .map((s) => {
                      const d = designById[s.id]
                      if (!d) return null
                      const previewField = buildFieldFromSuggestion(
                        {
                          ...s,
                          id: `preview_${s.id}`,
                        },
                        {
                          page: s.page,
                          x: d.x,
                          y: d.y,
                          width: d.width,
                          height: d.height,
                        },
                        1,
                      )
                      return (
                        <div
                          key={s.id}
                          className="fb-field upload-preview-field"
                          style={fieldStyle({ ...s, _design: d })}
                          title={s.labelText}
                        >
                          <FieldPreview field={previewField} />
                        </div>
                      )
                    })}
              </PdfViewer>
            </div>
            {suggestions.length > 0 && (
              <aside className="upload-suggestion-panel">
                <h3>Suggestions</h3>
                <p className="upload-suggestion-hint">Uncheck any region you do not want imported.</p>
                <ul className="upload-suggestion-list">
                  {suggestions.map((s) => (
                    <li key={s.id} className="upload-suggestion-item">
                      <label className="upload-suggestion-label">
                        <input
                          type="checkbox"
                          checked={enabledIds.has(s.id)}
                          onChange={() => toggleSuggestion(s.id)}
                        />
                        <span className="upload-suggestion-type">{s.fieldType}</span>
                        <span className="upload-suggestion-kind">{s.kind}</span>
                      </label>
                      <div className="upload-suggestion-text">
                        {s.labelText || '(no nearby label)'}
                      </div>
                      <div className="upload-suggestion-meta">
                        p.{s.page} · {(s.confidence * 100).toFixed(0)}%
                      </div>
                    </li>
                  ))}
                </ul>
              </aside>
            )}
          </div>
        </div>
      )}

      {uploadedFilename && (
        <div className="upload-post-actions">
          <Link to="/templates" className="upload-secondary-btn">
            View all templates
          </Link>
          <button type="button" className="upload-primary-btn" onClick={openFormBuilderWithSuggestions}>
            Open form builder
            {enabledIds.size > 0 ? ` (${enabledIds.size} fields)` : ''}
          </button>
        </div>
      )}

      {!uploadedFilename && (
        <Link to="/templates" className="back-link">
          View all templates
        </Link>
      )}
    </div>
  )
}
