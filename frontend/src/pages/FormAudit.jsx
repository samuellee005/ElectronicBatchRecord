import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PdfViewer from '../components/PdfViewer'
import PdfPageScrubber from '../components/PdfPageScrubber'
import PdfZoomControls from '../components/PdfZoomControls'
import { loadFormById } from '../api/client'
import { formatAuditEntryBlock } from '../utils/formatAuditTrail'
import './FormAudit.css'

const DESIGN_SCALE = 1.5

function getPageFieldsSpatialOrder(allFields, page) {
  if (!allFields?.length) return []
  return allFields
    .filter((f) => (f.page || 1) === page)
    .sort((a, b) => {
      const dy = (a.y ?? 0) - (b.y ?? 0)
      if (dy !== 0) return dy
      const dx = (a.x ?? 0) - (b.x ?? 0)
      if (dx !== 0) return dx
      return String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true })
    })
}

export default function FormAudit() {
  const [searchParams] = useSearchParams()
  const formId = searchParams.get('form')
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [scale, setScale] = useState(1.5)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const pdfRef = useRef(null)

  useEffect(() => {
    if (!formId) {
      setLoading(false)
      setError('Missing form id.')
      return
    }
    setLoading(true)
    setError(null)
    loadFormById(formId)
      .then((res) => {
        if (!res.success || !res.form) throw new Error(res.message || 'Form not found')
        setForm(res.form)
      })
      .catch((err) => setError(err.message || 'Failed to load form'))
      .finally(() => setLoading(false))
  }, [formId])

  const onPageRendered = useCallback(({ page, totalPages: n }) => {
    setCurrentPage(page)
    if (n != null) setTotalPages(n)
  }, [])

  const goToPdfPage = useCallback((page) => {
    pdfRef.current?.goToPage?.(page)
  }, [])

  const pageFields = useMemo(() => {
    if (!form?.fields) return []
    return getPageFieldsSpatialOrder(form.fields, currentPage)
  }, [form, currentPage])

  const auditBlocks = useMemo(() => {
    const trail = form?.auditTrail
    if (!Array.isArray(trail) || !trail.length) return []
    return trail.map((entry, i) => ({ ...formatAuditEntryBlock(entry), key: i, raw: entry }))
  }, [form])

  const scaleFactor = scale / DESIGN_SCALE

  if (!formId) {
    return (
      <div className="page-content form-audit-page">
        <h1 className="page-title">Form audit</h1>
        <p className="error-message">No form specified.</p>
        <Link to="/forms">Back to Batch Record Forms</Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="page-content form-audit-page">
        <h1 className="page-title">Form audit</h1>
        <p>Loading…</p>
      </div>
    )
  }

  if (error || !form) {
    return (
      <div className="page-content form-audit-page">
        <h1 className="page-title">Form audit</h1>
        <p className="error-message">{error || 'Form not found.'}</p>
        <Link to="/forms">Back to Batch Record Forms</Link>
      </div>
    )
  }

  const pdfFile = form.pdfFile || ''

  return (
    <div className="page-content form-audit-page">
      <div className="form-audit-header">
        <div>
          <h1 className="page-title">Form audit</h1>
          <p className="form-audit-subtitle">
            <strong>{form.name || 'Unnamed'}</strong>
            {form.version != null ? ` · Version ${form.version}` : ''}
            {form.isLatest ? ' (latest)' : ''}
          </p>
        </div>
        <Link to="/forms" className="btn btn-primary form-audit-back">
          Back to forms
        </Link>
      </div>

      <section className="form-audit-section">
        <h2 className="form-audit-section-title">Form layout</h2>
        <p className="form-audit-hint">
          PDF template with field positions (read-only). Switch pages to see all fields.
        </p>
        {pdfFile ? (
          <div className="form-audit-pdf-wrap">
            <PdfViewer
              ref={pdfRef}
              pdfUrl={`/uploads/${pdfFile}`}
              scale={scale}
              onPageRendered={onPageRendered}
              paginationPosition="both"
              hidePagination={totalPages <= 1}
              zoomControls={
                <PdfZoomControls
                  className="form-audit-zoom"
                  scale={scale}
                  onScaleChange={setScale}
                  minScale={0.5}
                  maxScale={3}
                  defaultScale={1.5}
                />
              }
              paginationScrubber={
                totalPages > 1 ? (
                  <PdfPageScrubber
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onGoToPage={goToPdfPage}
                  />
                ) : undefined
              }
            >
              <div className="form-audit-overlay-root">
                {pageFields.map((field) => (
                  <div
                    key={field.id}
                    className="form-audit-field-outline"
                    style={{
                      left: field.x * scaleFactor,
                      top: field.y * scaleFactor,
                      width: field.width * scaleFactor,
                      height: field.height * scaleFactor,
                    }}
                    title={`${field.label || 'Field'} (${field.type || '?'})`}
                  >
                    <span className="form-audit-field-label">{field.label || field.id}</span>
                  </div>
                ))}
              </div>
            </PdfViewer>
          </div>
        ) : (
          <p className="error-message">This form has no PDF file on record.</p>
        )}
      </section>

      <section className="form-audit-section form-audit-section--notes">
        <h2 className="form-audit-section-title">Audit trail</h2>
        {auditBlocks.length === 0 ? (
          <p className="form-audit-empty">No audit entries for this version.</p>
        ) : (
          <ul className="form-audit-list">
            {auditBlocks.map((b) => (
              <li key={b.key} className="form-audit-card">
                <div className="form-audit-card-headline">{b.headline}</div>
                <div className="form-audit-card-meta">{b.meta}</div>
                {b.bodyLines.length > 0 ? (
                  <ul className="form-audit-card-details">
                    {b.bodyLines.map((line, j) => (
                      <li key={j}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
