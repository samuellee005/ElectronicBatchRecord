import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import PdfViewer from '../components/PdfViewer'
import PdfPageScrubber from '../components/PdfPageScrubber'
import PdfZoomControls from '../components/PdfZoomControls'
import {
  loadFormById,
  loadFormByPdf,
  saveData,
  createBatchRecord,
  updateBatchRecord,
  isEbrApiDebug,
  getBatchRecord,
  exportBatchPdfBlob,
  listActiveUsers,
} from '../api/client'
import { useUserPrefs } from '../context/UserPrefsContext'
import './DataEntry.css'
import { buildTableMergeLayout, tableCellKey } from '../utils/tableMergeLayout'
import { tableColWidthPx, tableRowHeightPx } from '../utils/tableFieldDims'

/** Default matches FormBuilder `DEFAULT_INPUT_FONT_PX` when `inputFontSize` is unset. */
const OVERLAY_DEFAULT_INPUT_FONT_PX = 13

/** Per-field PDF font size (px) from Form Builder; drives --field-input-font-size on the overlay. */
function overlayFieldFontStyle(field) {
  const n = Number(field?.inputFontSize)
  const px =
    field?.inputFontSize != null && !Number.isNaN(n) && n > 0
      ? Math.min(48, Math.max(8, Math.round(n)))
      : OVERLAY_DEFAULT_INPUT_FONT_PX
  return { '--field-input-font-size': `${px}px` }
}

// ─── Field entry audit (timestamp, lock, corrections) ────────────────────────
const IDLE_LOCK_MS = 60 * 1000

function isFieldEntryObject(entry) {
  return entry != null && typeof entry === 'object' && 'v' in entry
}

function getEffectiveValue(entry) {
  if (entry == null) return undefined
  if (isFieldEntryObject(entry)) {
    const corrections = entry.corrections
    if (Array.isArray(corrections) && corrections.length > 0) {
      return corrections[corrections.length - 1].to
    }
    return entry.v
  }
  return entry
}

function isFieldEntryLocked(entry) {
  return isFieldEntryObject(entry) && entry.lockedAt != null
}

function normalizeEntry(entry, value, options = {}) {
  const { setEnteredAt, setLockedAt, recordedBy } = options
  const existing = isFieldEntryObject(entry) ? entry : null
  const now = new Date().toISOString()
  const next = {
    v: value,
    enteredAt: setEnteredAt ? (existing?.enteredAt ?? now) : existing?.enteredAt,
    lockedAt: setLockedAt ? (existing?.lockedAt ?? now) : existing?.lockedAt,
    corrections: existing?.corrections ?? [],
  }
  if (setLockedAt) {
    if (recordedBy != null && recordedBy !== '') {
      next.recordedBy = recordedBy
    } else if (existing?.recordedBy) {
      next.recordedBy = existing.recordedBy
    }
  } else if (existing?.recordedBy != null) {
    next.recordedBy = existing.recordedBy
  }
  return next
}

function addCorrection(entry, newValue, correctedBy, correctedAt) {
  const current = getEffectiveValue(entry)
  const corrections = (isFieldEntryObject(entry) && entry.corrections) ? [...entry.corrections] : []
  corrections.push({ from: current, to: newValue, by: correctedBy, at: correctedAt })
  return {
    ...(isFieldEntryObject(entry) ? entry : {}),
    v: newValue,
    enteredAt: isFieldEntryObject(entry) ? entry.enteredAt : undefined,
    lockedAt: isFieldEntryObject(entry) ? entry.lockedAt : undefined,
    corrections,
  }
}

function isRequired(field) {
  const v = field.required
  return v === true || v === 'true' || v === 1
}

function parseMultiselectValue(v) {
  if (Array.isArray(v)) return v.filter(x => x != null && String(x).trim() !== '')
  if (typeof v === 'string' && v.trim()) {
    try {
      const j = JSON.parse(v)
      if (Array.isArray(j)) return j.filter(x => x != null && String(x).trim() !== '')
    } catch { /* ignore */ }
  }
  return []
}

function normalizeTableValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.cells && typeof v.cells === 'object') {
    return { cells: { ...v.cells } }
  }
  return { cells: {} }
}

function iterTableAnchorKeys(field) {
  const { rowIds, colIds, covered } = buildTableMergeLayout(field)
  const keys = []
  for (let i = 0; i < rowIds.length; i++) {
    for (let j = 0; j < colIds.length; j++) {
      const key = tableCellKey(rowIds[i], colIds[j])
      if (covered.has(key)) continue
      keys.push(key)
    }
  }
  return keys
}

/**
 * Data-table fields: `type === 'table'` (any case) or legacy JSON with rows/columns but missing/wrong type.
 * Prevents the corrections panel from falling through to `displayFieldValue` and dumping every filled cell as "Current:".
 */
function isTableField(field) {
  if (!field || typeof field !== 'object') return false
  const t = String(field.type ?? '').trim().toLowerCase()
  if (t === 'table') return true
  const cols = field.tableColumns
  const rows = field.tableRows
  return Array.isArray(cols) && cols.length > 0 && Array.isArray(rows) && rows.length > 0
}

function tableCellIsFilled(cells, key) {
  const v = cells[key]
  return v !== undefined && v !== null && String(v).trim() !== ''
}

function normalizedTableCellString(cells, key) {
  const v = cells[key]
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

/** "Row label / Col label" for a cell key (rowId::colId). */
function tableCellDisplayLabel(field, key) {
  const sep = '::'
  const i = String(key).indexOf(sep)
  if (i < 0) return String(key)
  const rowId = String(key).slice(0, i)
  const colId = String(key).slice(i + sep.length)
  const rl = (field.tableRows || []).find((x) => x.id === rowId)?.label || rowId
  const cl = (field.tableColumns || []).find((x) => x.id === colId)?.label || colId
  return `${rl} / ${cl}`
}

/** Anchor keys whose values differ between two table snapshots (one correction step). */
function getTableCorrectionChangedKeys(field, fromValue, toValue) {
  if (!isTableField(field)) return []
  const fromCells = normalizeTableValue(fromValue).cells
  const toCells = normalizeTableValue(toValue).cells
  const changed = []
  for (const key of iterTableAnchorKeys(field)) {
    if (normalizedTableCellString(fromCells, key) !== normalizedTableCellString(toCells, key)) {
      changed.push(key)
    }
  }
  return changed
}

/** Stable reading order for a list of cell keys (matches table layout). */
function sortTableKeysByFieldOrder(field, keys) {
  if (!keys?.length) return []
  const order = new Map()
  iterTableAnchorKeys(field).forEach((k, i) => order.set(k, i))
  return [...keys].sort((a, b) => (order.get(a) ?? 9999) - (order.get(b) ?? 9999))
}

/** One side of a table correction (only changed cells), for the corrections panel. */
function displayTableCorrectionSide(field, value, changedKeys) {
  const { cells } = normalizeTableValue(value)
  const parts = []
  for (const key of changedKeys) {
    const lab = tableCellDisplayLabel(field, key)
    const raw = cells[key]
    const display = raw !== undefined && raw !== null && String(raw).trim() !== '' ? String(raw) : '-'
    parts.push(`${lab}: ${display}`)
  }
  return parts.length ? parts.join('; ') : '-'
}

function isTableFieldFilled(field, value) {
  const { cells } = normalizeTableValue(value)
  const keys = iterTableAnchorKeys(field)
  if (keys.length === 0) return false
  const anyFilled = keys.some((k) => tableCellIsFilled(cells, k))
  if (isRequired(field)) {
    return keys.every((k) => tableCellIsFilled(cells, k))
  }
  return anyFilled
}

function isTableFieldEmpty(field, value) {
  const { cells } = normalizeTableValue(value)
  const keys = iterTableAnchorKeys(field)
  if (keys.length === 0) return true
  return !keys.some((k) => tableCellIsFilled(cells, k))
}

/**
 * Normalize stored signature payloads to a usable <img src>.
 * Handles data URLs, URLs, and raw base64 (no `data:image/...` prefix) from exports or legacy saves.
 */
function normalizeSignatureImageSrc(value) {
  if (value == null || value === '') return null
  const s = String(value).trim()
  if (!s) return null
  if (/^data:image\//i.test(s)) return s
  if (s.startsWith('blob:')) return s
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('/')) return s
  const compact = s.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+=*$/.test(compact) || compact.length < 32) return null
  if (compact.startsWith('iVBORw0KGgo')) return `data:image/png;base64,${compact}`
  if (compact.startsWith('/9j/')) return `data:image/jpeg;base64,${compact}`
  return null
}

/** Value can be used as <img src> (after normalization). */
function isSignatureImageSrc(value) {
  return normalizeSignatureImageSrc(value) != null
}

/**
 * Corrections UI: never put data:/blob: in <a href> — print/PDF often dumps the full URI as text.
 * Use a <button> (no href) for those; a normal <a> for http(s) and app paths.
 * Print: hide interactive controls and show the actual signature image (before/after), not labels or base64 text.
 */
function SignatureCorrectionLink({ value, children }) {
  if (value === undefined || value === null || value === '') {
    return <span className="de-signature-correction-empty">—</span>
  }
  const src = normalizeSignatureImageSrc(value)
  if (!src) {
    return <span className="de-signature-correction-empty">—</span>
  }
  const label = children ?? 'View signature'
  const opaque = /^data:/i.test(src) || src.startsWith('blob:')
  const openInNewTab = (e) => {
    e.stopPropagation()
    e.preventDefault()
    window.open(src, '_blank', 'noopener,noreferrer')
  }
  const interactive = opaque ? (
    <button type="button" className="de-signature-correction-link" onClick={openInNewTab}>
      {label}
    </button>
  ) : (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="de-signature-correction-link"
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  )
  return (
    <span className="de-signature-correction-wrap">
      <span className="de-signature-correction-interactive">{interactive}</span>
      <span className="de-signature-correction-print-fallback" aria-hidden="true">
        <img src={src} alt="" className="de-signature-correction-print-img" />
        <span className="de-signature-correction-print-caption">{label}</span>
      </span>
    </span>
  )
}

/** Corrections list: signature UI for signature fields, or any value that resolves to an image src. */
function correctionsUseSignatureLink(field, value) {
  if (field?.type === 'signature') return true
  return normalizeSignatureImageSrc(value) != null
}

/** Read-only signature on the PDF overlay (locked fields) — show image, not raw data URL text. */
function ReadonlySignatureValue({ value, className = '' }) {
  if (value == null || value === '') return <span className={className}>—</span>
  const src = normalizeSignatureImageSrc(value)
  if (src) {
    return <img src={src} alt="" className={`de-signature-readonly-img${className ? ` ${className}` : ''}`} />
  }
  return <span className={className}>{String(value)}</span>
}

function isCheckboxChecked(value) {
  return value === true || value === 'true' || value === 1
}

/** Submitted / locked checkbox: drawn box on screen and in print; native clipped for accessibility only. */
function ReadonlyCheckboxValue({ value, className = '' }) {
  const checked = isCheckboxChecked(value)
  return (
    <span
      className={`de-checkbox-readonly${className ? ` ${className}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <input type="checkbox" checked={checked} disabled tabIndex={-1} aria-label={checked ? 'Checked' : 'Unchecked'} />
      <span
        className={`de-checkbox-print-visual${checked ? ' de-checkbox-print-visual--checked' : ''}`}
        aria-hidden="true"
      />
    </span>
  )
}

function displayFieldValue(field, value) {
  if (field.type === 'multiselect') {
    const arr = parseMultiselectValue(value)
    return arr.length ? arr.join(', ') : '—'
  }
  if (field.type === 'collaborator') {
    if (!value || typeof value !== 'object') return '—'
    const p = value.primaryDisplayName || value.primaryUserId || '—'
    const s = value.secondaryDisplayName || value.secondaryUserId || '—'
    const rec = value.reviewerIsDesignatedRecorder ? ' · Reviewer records all entry' : ''
    return `Primary: ${p} · Reviewer: ${s}${rec}`
  }
  if (isTableField(field)) {
    const { cells } = normalizeTableValue(value)
    const { rowIds, colIds, covered } = buildTableMergeLayout(field)
    const parts = []
    for (let i = 0; i < rowIds.length; i++) {
      for (let j = 0; j < colIds.length; j++) {
        const key = tableCellKey(rowIds[i], colIds[j])
        if (covered.has(key)) continue
        if (!tableCellIsFilled(cells, key)) continue
        const rl = (field.tableRows || []).find((x) => x.id === rowIds[i])?.label || rowIds[i]
        const cl = (field.tableColumns || []).find((x) => x.id === colIds[j])?.label || colIds[j]
        parts.push(`${rl} / ${cl}: ${cells[key]}`)
      }
    }
    return parts.length ? parts.join('; ') : '—'
  }
  if (field.type === 'signature') {
    if (value === undefined || value === null || value === '') return '—'
    if (normalizeSignatureImageSrc(value)) return 'Signature captured'
    const t = String(value).trim()
    if (t.length > 120) return 'Signature (see corrections for link)'
    return t || '—'
  }
  if (value === undefined || value === null || value === '') return '—'
  if (field.type === 'checkbox') {
    return isCheckboxChecked(value) ? '✓' : '—'
  }
  if (normalizeSignatureImageSrc(value)) {
    return 'Signature captured'
  }
  return String(value)
}

function isFieldValueFilled(field, value) {
  if (field.type === 'checkbox') {
    return value === true || value === 'true' || value === 1
  }
  if (field.type === 'multiselect') {
    return parseMultiselectValue(value).length > 0
  }
  if (field.type === 'collaborator') {
    if (!value || typeof value !== 'object') return false
    const a = value.primaryUserId
    const b = value.secondaryUserId
    return !!(a && b && a !== b)
  }
  if (isTableField(field)) {
    return isTableFieldFilled(field, value)
  }
  return value !== undefined && value !== null && value !== '' && (typeof value !== 'string' || value.trim() !== '')
}

function getCollaboratorPolicy(formConfig, formData, idToName) {
  if (!formConfig?.fields || !idToName) return null
  for (const f of formConfig.fields) {
    if (f.type !== 'collaborator') continue
    const ent = formData[f.id]
    if (!isFieldEntryLocked(ent)) continue
    const v = getEffectiveValue(ent)
    if (!v || typeof v !== 'object') continue
    const { primaryUserId, secondaryUserId, reviewerIsDesignatedRecorder } = v
    if (!primaryUserId || !secondaryUserId || primaryUserId === secondaryUserId) continue
    return {
      fieldId: f.id,
      primaryName: idToName[primaryUserId] || primaryUserId,
      secondaryName: idToName[secondaryUserId] || secondaryUserId,
      reviewerIsDesignatedRecorder: !!reviewerIsDesignatedRecorder,
    }
  }
  return null
}

function collaboratorDraft(value) {
  const base = { primaryUserId: '', secondaryUserId: '', reviewerIsDesignatedRecorder: false }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...base, ...value }
  }
  return base
}

function buildStages(fields) {
  if (!fields || fields.length === 0) return []
  const map = {}
  fields.forEach(f => {
    const name = f.stageInProcess || 'Default Stage'
    if (!map[name]) {
      map[name] = {
        stage: name,
        order: f.stageOrder != null ? f.stageOrder : null,
        fields: [],
      }
    }
    map[name].fields.push(f)
  })
  return Object.values(map).sort((a, b) => {
    if (a.order != null && b.order != null) return a.order - b.order
    if (a.order != null) return -1
    if (b.order != null) return 1
    return 0
  })
}

function computeStageCompletion(stages, formData) {
  const comp = {}
  stages.forEach(s => {
    comp[s.stage] = s.fields.every(f => !isRequired(f) || isFieldValueFilled(f, formData[f.id]))
  })
  return comp
}

/** Fields on one page: top to bottom, then left to right (FormBuilder x/y). Stable when form array order changes. */
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

function getMaxFieldPage(allFields) {
  let m = 1
  for (const f of allFields || []) m = Math.max(m, f.page || 1)
  return m
}

/** Fields in a stage in document order (page ascending, then spatial order on each page). */
function getFieldsInStageDocumentOrder(allFields, stageName) {
  const sn = String(stageName)
  const maxP = getMaxFieldPage(allFields)
  const out = []
  for (let p = 1; p <= maxP; p++) {
    for (const f of getPageFieldsSpatialOrder(allFields, p)) {
      if ((f.stageInProcess || 'Default Stage') === sn) out.push(f)
    }
  }
  return out
}

function findFirstUnfilledFieldInStage(allFields, stageName, formData) {
  for (const f of getFieldsInStageDocumentOrder(allFields, stageName)) {
    const v = getEffectiveValue(formData[f.id])
    if (!isFieldValueFilled(f, v)) return f
  }
  return null
}

/** Next field to fill in this stage, or first field in the stage if all are filled (for review). */
function findTargetFieldForStageNavigation(allFields, stageName, formData) {
  const u = findFirstUnfilledFieldInStage(allFields, stageName, formData)
  if (u) return u
  const ordered = getFieldsInStageDocumentOrder(allFields, stageName)
  return ordered[0] || null
}

// Build ref numbers for fields that have corrections (side panel + overlay badges).
// Ref = 1-based index among all fields on the page in spatial order (not form array or fill order).
function useCorrectionRefs(fields, formData, currentPage) {
  return useMemo(() => {
    if (!fields?.length) return { refMap: {}, list: [] }
    const pageFields = getPageFieldsSpatialOrder(fields, currentPage)
    const refMap = {}
    pageFields.forEach((f, i) => {
      const entry = formData[f.id]
      if (
        isFieldEntryObject(entry) &&
        Array.isArray(entry.corrections) &&
        entry.corrections.length > 0
      ) {
        refMap[f.id] = i + 1
      }
    })
    const list = pageFields
      .filter((f) => {
        const entry = formData[f.id]
        return (
          isFieldEntryObject(entry) &&
          Array.isArray(entry.corrections) &&
          entry.corrections.length > 0
        )
      })
      .map((f) => ({
        field: f,
        entry: formData[f.id],
        ref: refMap[f.id],
      }))
    return { refMap, list }
  }, [fields, formData, currentPage])
}

function isStageAccessible(stage, stages, stageCompletion) {
  if (stage.order == null) return true
  for (const prev of stages) {
    if (prev.order != null && prev.order < stage.order && !stageCompletion[prev.stage]) {
      return false
    }
  }
  return true
}

function allRequiredFilled(fields, formData) {
  if (!fields) return true
  return fields.every(f => !isRequired(f) || isFieldValueFilled(f, formData[f.id]))
}

// ─── Signature Pad ───────────────────────────────────────────────────────────
function SignaturePad({ fieldId, width, height, disabled, value, onChange }) {
  const canvasRef = useRef(null)
  const drawing = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const initialized = useRef(false)

  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const wrap = canvas.parentElement
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      requestAnimationFrame(initCanvas)
      return
    }
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    if (value && typeof value === 'string') {
      const img = new Image()
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, rect.width, rect.height)
        } catch {
          /* ignore */
        }
      }
      img.onerror = () => {}
      img.src = value
    }
    initialized.current = true
  }, [value])

  useEffect(() => {
    const t = setTimeout(initCanvas, 60)
    return () => clearTimeout(t)
  }, [initCanvas])

  const coords = useCallback((e) => {
    const canvas = canvasRef.current
    const r = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const sx = canvas.width / r.width
    const sy = canvas.height / r.height
    let cx, cy
    if (e.touches?.length) { cx = e.touches[0].clientX; cy = e.touches[0].clientY }
    else if (e.changedTouches?.length) { cx = e.changedTouches[0].clientX; cy = e.changedTouches[0].clientY }
    else { cx = e.clientX; cy = e.clientY }
    return { x: (cx - r.left) * sx / dpr, y: (cy - r.top) * sy / dpr }
  }, [])

  const onStart = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    drawing.current = true
    const c = coords(e)
    last.current = c
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#000'
      ctx.beginPath()
      ctx.arc(c.x, c.y, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [coords])

  const onMove = useCallback((e) => {
    if (!drawing.current) return
    e.preventDefault()
    e.stopPropagation()
    const c = coords(e)
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) {
      ctx.beginPath()
      ctx.moveTo(last.current.x, last.current.y)
      ctx.lineTo(c.x, c.y)
      ctx.stroke()
    }
    last.current = c
  }, [coords])

  const onEnd = useCallback((e) => {
    if (!drawing.current) return
    e.preventDefault()
    e.stopPropagation()
    drawing.current = false
    if (canvasRef.current) onChange(canvasRef.current.toDataURL('image/png'))
  }, [onChange])

  const clear = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    onChange('')
  }, [onChange])

  return (
    <div className="sig-container">
      <div className={`sig-canvas-wrap${disabled ? ' disabled' : ''}`}>
        <canvas
          ref={canvasRef}
          onMouseDown={disabled ? undefined : onStart}
          onMouseMove={disabled ? undefined : onMove}
          onMouseUp={disabled ? undefined : onEnd}
          onMouseLeave={disabled ? undefined : onEnd}
          onTouchStart={disabled ? undefined : onStart}
          onTouchMove={disabled ? undefined : onMove}
          onTouchEnd={disabled ? undefined : onEnd}
          onTouchCancel={disabled ? undefined : onEnd}
        />
      </div>
      <div className="sig-controls">
        <button type="button" className="sig-clear-btn" disabled={disabled} onClick={clear}>Clear</button>
      </div>
    </div>
  )
}

// ─── Corrections panel (off-page, right side): ref number + field label + correction history ──
function CorrectionsPanel({ correctionList, formatTs, noOuterWrapper }) {
  if (!correctionList?.length) return null
  const inner = (
    <>
      <h3 className="de-corrections-panel-title">Corrections (this page)</h3>
      <p className="de-corrections-panel-hint">
        Only corrections for fields on the page you are viewing. Reference numbers match field badges (top to bottom, then left to right).
      </p>
      <div className="de-corrections-list">
        {correctionList.map(({ field, entry, ref }) => {
          const refNum = ref
          const corrections = entry.corrections || []
          const currentValue = getEffectiveValue(entry)
          const label = field.label || 'Field'
          return (
            <div key={field.id} className="de-correction-block" data-ref={refNum}>
              <div className="de-correction-block-header">
                <span className="de-correction-ref" aria-label={`Reference ${refNum}`}>{refNum}</span>
                <span className="de-correction-label">{label}</span>
                {!isTableField(field) && (
                  <span className="de-correction-current">
                    Current:{' '}
                    {field.type === 'checkbox' ? (
                      <ReadonlyCheckboxValue value={currentValue} className="de-correction-checkbox" />
                    ) : correctionsUseSignatureLink(field, currentValue) ? (
                      <SignatureCorrectionLink value={currentValue}>View current signature</SignatureCorrectionLink>
                    ) : (
                      displayFieldValue(field, currentValue)
                    )}
                  </span>
                )}
              </div>
              <ul className="de-correction-history">
                {corrections.map((c, i) => {
                  const tableDeltaKeys = isTableField(field)
                    ? sortTableKeysByFieldOrder(field, getTableCorrectionChangedKeys(field, c.from, c.to))
                    : null
                  return (
                    <li key={i}>
                      <span className="de-correction-old">
                        {field.type === 'checkbox' ? (
                          <ReadonlyCheckboxValue value={c.from} className="de-correction-checkbox" />
                        ) : isTableField(field) ? (
                          displayTableCorrectionSide(field, c.from, tableDeltaKeys)
                        ) : correctionsUseSignatureLink(field, c.from) ? (
                          <SignatureCorrectionLink value={c.from}>Previous signature</SignatureCorrectionLink>
                        ) : (
                          displayFieldValue(field, c.from)
                        )}
                      </span>
                      <span className="de-correction-arrow" aria-hidden>
                        →
                      </span>
                      <span className="de-correction-new">
                        {field.type === 'checkbox' ? (
                          <ReadonlyCheckboxValue value={c.to} className="de-correction-checkbox" />
                        ) : isTableField(field) ? (
                          displayTableCorrectionSide(field, c.to, tableDeltaKeys)
                        ) : correctionsUseSignatureLink(field, c.to) ? (
                          <SignatureCorrectionLink value={c.to}>Updated signature</SignatureCorrectionLink>
                        ) : (
                          displayFieldValue(field, c.to)
                        )}
                      </span>
                      <span className="de-correction-meta">({c.by}, {formatTs(c.at)})</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </>
  )
  if (noOuterWrapper) return inner
  return <div className="de-corrections-panel">{inner}</div>
}

// Scale at which the form was designed (FormBuilder default); overlay coords are in this space
const DESIGN_SCALE = 1.5

function overlayFieldSelector(fieldId) {
  const s = String(fieldId)
  const esc =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(s)
      : s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[data-de-overlay-field="${esc}"]`
}

/** Position the fixed field panel so its vertical center lines up with the selected overlay field. */
function computeFieldPanelAnchorStyle(fieldId) {
  if (typeof document === 'undefined') return null
  const el = document.querySelector(overlayFieldSelector(fieldId))
  if (!el) return null
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight
  const TOP_MIN = 72
  const BOTTOM_PAD = 20
  const maxPanelH = Math.min(560, Math.max(200, vh - TOP_MIN - BOTTOM_PAD))
  const half = maxPanelH / 2
  let fieldMid = r.top + r.height / 2
  fieldMid = Math.max(TOP_MIN + half, Math.min(fieldMid, vh - BOTTOM_PAD - half))
  return {
    top: `${fieldMid}px`,
    transform: 'translateY(-50%)',
    maxHeight: `${maxPanelH}px`,
    bottom: 'auto',
  }
}

function initializeCorrectionDraft(field, rawValue) {
  if (field.type === 'multiselect') return parseMultiselectValue(rawValue)
  if (field.type === 'checkbox') return rawValue === true || rawValue === 'true' || rawValue === 1
  if (field.type === 'collaborator') return collaboratorDraft(rawValue)
  if (field.type === 'table') return normalizeTableValue(rawValue)
  return rawValue ?? ''
}

function normalizeCorrectionForSave(field, newValue, activeUsers) {
  if (field.type === 'multiselect')
    return [...(Array.isArray(newValue) ? newValue : parseMultiselectValue(newValue))]
  if (field.type === 'collaborator') {
    const cv = collaboratorDraft(newValue)
    const map = Object.fromEntries(activeUsers.map((u) => [u.id, u.displayName]))
    return {
      ...cv,
      primaryDisplayName: map[cv.primaryUserId] || cv.primaryUserId,
      secondaryDisplayName: map[cv.secondaryUserId] || cv.secondaryUserId,
    }
  }
  if (field.type === 'table') return normalizeTableValue(newValue)
  return newValue
}

function fieldTypeLabel(type) {
  const m = {
    text: 'Text',
    date: 'Date',
    number: 'Number',
    signature: 'Signature',
    textarea: 'Text area',
    dropdown: 'Dropdown',
    checkbox: 'Checkbox',
    time: 'Time',
    radio: 'Radio group',
    multiselect: 'Multi select',
    collaborator: 'Collaborator',
    table: 'Data table',
  }
  return m[type] || type
}

/** Read-only audit lines (same facts as the on-field info popover). */
function FieldAuditDetails({ entry, formatTs, correctionRef }) {
  if (!isFieldEntryObject(entry)) return null
  const enteredAt = entry.enteredAt
  const lockedAt = entry.lockedAt
  const recordedBy = entry.recordedBy
  const corrs = Array.isArray(entry.corrections) ? entry.corrections : []
  const show =
    enteredAt ||
    lockedAt ||
    (recordedBy != null && recordedBy !== '') ||
    corrs.length > 0 ||
    correctionRef != null
  if (!show) return null
  return (
    <div className="de-field-panel-audit">
      <div className="de-field-panel-section-title">Entry history</div>
      {enteredAt && (
        <div className="de-field-panel-row">
          <span className="de-field-panel-k">First entered</span>
          <span className="de-field-panel-v">{formatTs(enteredAt)}</span>
        </div>
      )}
      {lockedAt && (
        <div className="de-field-panel-row">
          <span className="de-field-panel-k">Submitted / locked</span>
          <span className="de-field-panel-v">{formatTs(lockedAt)}</span>
        </div>
      )}
      {recordedBy != null && recordedBy !== '' && (
        <div className="de-field-panel-row">
          <span className="de-field-panel-k">Recorded by</span>
          <span className="de-field-panel-v">{recordedBy}</span>
        </div>
      )}
      {correctionRef != null && (
        <div className="de-field-panel-row">
          <span className="de-field-panel-k">Correction ref</span>
          <span className="de-field-panel-v">#{correctionRef} (see Corrections panel for this page)</span>
        </div>
      )}
      {corrs.length > 0 && (
        <ul className="de-field-panel-correction-list">
          {corrs.map((c, i) => (
            <li key={i}>
              {formatTs(c.at)} — {c.by || '—'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Right-side panel: field definition (read-only) + optional value edit + actions.
 */
function FieldDetailPanel({
  field,
  entry,
  stageAccessible,
  readOnly: batchReadOnly,
  onChange,
  onLockField,
  onStartCorrection,
  onClose,
  correctionRef,
  activeUsers,
  collaboratorSetupComplete,
  formatTs,
  className = '',
  style: panelStyle,
  editingCorrectionId = null,
  correctionDraft,
  onCorrectionDraftChange,
  onSaveCorrection,
  /** Same scale as PDF overlay (field.width * scale/DESIGN_SCALE). */
  overlayScale = DESIGN_SCALE,
}) {
  const value = getEffectiveValue(entry)
  const fieldLocked = isFieldEntryLocked(entry)
  const stageLocked = !stageAccessible || batchReadOnly
  const req = isRequired(field)
  const blockedByCollaborator =
    field.type !== 'collaborator' && !collaboratorSetupComplete
  const hasValue = isFieldValueFilled(field, value)
  const canSubmit =
    hasValue && !fieldLocked && !stageLocked && !blockedByCollaborator

  const isEditingCorrectionHere =
    editingCorrectionId === field.id && fieldLocked && !batchReadOnly
  const showValueEditors =
    (!fieldLocked && !stageLocked && !batchReadOnly) ||
    (isEditingCorrectionHere && !stageLocked && !batchReadOnly)
  const editSourceValue = isEditingCorrectionHere ? correctionDraft : value
  const setFieldValue = (v) => {
    if (isEditingCorrectionHere) onCorrectionDraftChange(v)
    else onChange(field.id, v)
  }

  let valueEditor = null
  if (showValueEditors && (!isEditingCorrectionHere || correctionDraft !== undefined)) {
    switch (field.type) {
      case 'text':
        valueEditor = (
          <input
            type="text"
            className="de-field-panel-input"
            placeholder={field.placeholder || ''}
            value={editSourceValue ?? ''}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        )
        break
      case 'textarea':
        valueEditor = (
          <textarea
            className="de-field-panel-textarea"
            placeholder={field.placeholder || ''}
            value={editSourceValue ?? ''}
            rows={3}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        )
        break
      case 'number':
        valueEditor = field.unit ? (
          <div className="unit-input-group">
            <input
              type="number"
              className="de-field-panel-input"
              placeholder={field.placeholder || ''}
              value={editSourceValue ?? ''}
              onChange={(e) => setFieldValue(e.target.value)}
            />
            <div className="unit-display">{field.unit}</div>
          </div>
        ) : (
          <input
            type="number"
            className="de-field-panel-input"
            placeholder={field.placeholder || ''}
            value={editSourceValue ?? ''}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        )
        break
      case 'date':
        valueEditor = (
          <input
            type="date"
            className="de-field-panel-input"
            value={editSourceValue ?? ''}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        )
        break
      case 'time': {
        const t = typeof editSourceValue === 'string' ? editSourceValue.slice(0, 5) : ''
        valueEditor = (
          <input
            type="time"
            className="de-field-panel-input"
            value={t}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        )
        break
      }
      case 'dropdown':
        valueEditor = (
          <select
            className="de-field-panel-input"
            value={editSourceValue ?? ''}
            onChange={(e) => setFieldValue(e.target.value)}
          >
            <option value="">— Select —</option>
            {(field.options || []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )
        break
      case 'checkbox':
        valueEditor = (
          <label className="de-field-panel-check">
            <input
              type="checkbox"
              checked={editSourceValue === true || editSourceValue === 'true' || editSourceValue === 1}
              onChange={(e) => setFieldValue(e.target.checked)}
            />
            <span>Checked</span>
          </label>
        )
        break
      case 'radio':
        valueEditor = (
          <select
            className="de-field-panel-input"
            value={editSourceValue ?? ''}
            onChange={(e) => setFieldValue(e.target.value)}
          >
            <option value="">— Select —</option>
            {(field.options || []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )
        break
      case 'multiselect': {
        const selected = parseMultiselectValue(editSourceValue)
        valueEditor = (
          <div className="de-field-panel-multiselect">
            {(field.options || []).map((opt) => (
              <label key={opt} className="de-field-panel-check">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => {
                    const next = selected.includes(opt)
                      ? selected.filter((x) => x !== opt)
                      : [...selected, opt]
                    setFieldValue(next)
                  }}
                />
                <span>{opt}</span>
              </label>
            ))}
          </div>
        )
        break
      }
      case 'collaborator': {
        const cv = collaboratorDraft(editSourceValue)
        const opts = activeUsers.filter((u) => u.active !== false)
        valueEditor = (
          <div className="overlay-collaborator de-field-panel-collab">
            {field.helpText && <p className="overlay-collab-help">{field.helpText}</p>}
            <label className="overlay-collab-label">
              Primary analyst
              <select
                value={cv.primaryUserId}
                onChange={(e) =>
                  setFieldValue({ ...cv, primaryUserId: e.target.value })
                }
              >
                <option value="">— Select —</option>
                {opts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="overlay-collab-label">
              Secondary reviewer
              <select
                value={cv.secondaryUserId}
                onChange={(e) =>
                  setFieldValue({ ...cv, secondaryUserId: e.target.value })
                }
              >
                <option value="">— Select —</option>
                {opts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="overlay-collab-check">
              <input
                type="checkbox"
                checked={!!cv.reviewerIsDesignatedRecorder}
                onChange={(e) =>
                  setFieldValue({ ...cv, reviewerIsDesignatedRecorder: e.target.checked })
                }
              />
              Secondary reviewer is the designated recorder for all data entry
            </label>
          </div>
        )
        break
      }
      case 'table':
        valueEditor = (
          <div className="de-field-panel-table">
            <TableFieldInput
              field={field}
              value={editSourceValue}
              onChange={(next) => setFieldValue(next)}
              disabled={false}
              showRowColumnLabels
            />
          </div>
        )
        break
      case 'signature': {
        const sigFactor = overlayScale / DESIGN_SCALE
        valueEditor = isEditingCorrectionHere ? (
          <div className="de-field-panel-sig-correction">
            <p className="de-field-panel-hint">Draw a new signature below, or clear and re-sign.</p>
            <SignaturePad
              fieldId={`${field.id}-panel-correction`}
              width={field.width * sigFactor}
              height={field.height * sigFactor}
              disabled={false}
              value={typeof editSourceValue === 'string' ? editSourceValue : ''}
              onChange={(val) => setFieldValue(val)}
            />
          </div>
        ) : (
          <p className="de-field-panel-hint">
            Draw or clear the signature using the field on the document. The preview updates as you draw.
          </p>
        )
        break
      }
      default:
        valueEditor = (
          <input
            type="text"
            className="de-field-panel-input"
            value={editSourceValue ?? ''}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        )
    }
  }

  const handlePanelKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (e.target.closest?.('button')) return
    if (e.target.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return
    if (
      isEditingCorrectionHere &&
      onSaveCorrection &&
      correctionDraft !== undefined
    ) {
      e.preventDefault()
      onSaveCorrection(field.id, normalizeCorrectionForSave(field, correctionDraft, activeUsers))
      return
    }
    if (!canSubmit || !onLockField) return
    e.preventDefault()
    onLockField(field.id)
  }

  return (
    <aside
      className={`de-field-detail-panel${className ? ` ${className}` : ''}`}
      aria-label="Field details"
      style={panelStyle}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="de-field-detail-panel-header">
        <h3 className="de-field-detail-panel-title">{field.label || 'Field'}</h3>
        <button type="button" className="de-field-detail-panel-close" onClick={onClose} aria-label="Close field details">
          &times;
        </button>
      </div>
      <div className="de-field-detail-panel-body">
        {!stageAccessible && (
          <p className="de-field-panel-stage-lock">
            This stage is not available yet. Complete earlier stages in order first.
          </p>
        )}
        <div className="de-field-panel-meta">
          {req && <span className="de-field-panel-badge de-field-panel-badge-req">Required</span>}
          <span className="de-field-panel-badge">{fieldTypeLabel(field.type)}</span>
          {field.stageInProcess?.trim() && (
            <span className="de-field-panel-badge de-field-panel-badge-stage">Stage: {field.stageInProcess}</span>
          )}
        </div>
        {field.placeholder && ['text', 'number', 'textarea', 'time'].includes(field.type) && (
          <p className="de-field-panel-hint">
            <span className="de-field-panel-k">Placeholder: </span>
            {field.placeholder}
          </p>
        )}
        {field.type === 'number' && field.unit && (
          <p className="de-field-panel-hint">
            <span className="de-field-panel-k">Unit: </span>
            {field.unit}
          </p>
        )}
        {(field.type === 'dropdown' || field.type === 'radio' || field.type === 'multiselect') &&
          (field.options || []).length > 0 && (
            <p className="de-field-panel-hint">
              <span className="de-field-panel-k">Options: </span>
              {(field.options || []).join(', ')}
            </p>
          )}
        {field.type === 'collaborator' && field.helpText && (
          <p className="de-field-panel-hint">{field.helpText}</p>
        )}

        <div className="de-field-panel-section-title">Current value</div>
        {showValueEditors && valueEditor ? (
          valueEditor
        ) : (
          <div className="de-field-panel-readonly-value">
            {field.type === 'table' ? (
              <TableFieldInput field={field} value={value} readOnly showRowColumnLabels />
            ) : field.type === 'checkbox' ? (
              <ReadonlyCheckboxValue value={value} className="de-field-panel-checkbox-readonly" />
            ) : field.type === 'signature' && value && isSignatureImageSrc(value) ? (
              <img src={value} alt="Signature" className="de-field-panel-sig-preview" />
            ) : (
              <span>{displayFieldValue(field, value)}</span>
            )}
          </div>
        )}

        <FieldAuditDetails entry={entry} formatTs={formatTs} correctionRef={correctionRef} />

        <div className="de-field-panel-actions">
          {canSubmit && onLockField && (
            <button type="button" className="btn btn-primary de-field-panel-submit" onClick={() => onLockField(field.id)}>
              Submit field
            </button>
          )}
          {isEditingCorrectionHere && onSaveCorrection && (
            <>
              <button
                type="button"
                className="btn btn-primary de-field-panel-submit"
                onClick={() =>
                  onSaveCorrection(
                    field.id,
                    normalizeCorrectionForSave(field, correctionDraft, activeUsers),
                  )
                }
              >
                Save correction
              </button>
              <button type="button" className="btn btn-save" onClick={() => onStartCorrection(null)}>
                Cancel
              </button>
            </>
          )}
          {fieldLocked && !batchReadOnly && !isEditingCorrectionHere && (
            <button type="button" className="btn btn-save" onClick={() => onStartCorrection(field.id)}>
              Edit (correction)
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

/** Info icon: click to show entered time, lock time, recorded-by, correction history (reduces on-form clutter). */
function FieldAuditInfoPopover({ entry, formatTs, correctionRef }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!isFieldEntryObject(entry)) return null
  const enteredAt = entry.enteredAt
  const lockedAt = entry.lockedAt
  const recordedBy = entry.recordedBy
  const corrs = Array.isArray(entry.corrections) ? entry.corrections : []
  const show =
    enteredAt ||
    lockedAt ||
    (recordedBy != null && recordedBy !== '') ||
    corrs.length > 0 ||
    correctionRef != null
  if (!show) return null

  return (
    <div className="overlay-audit-info-wrap" ref={rootRef}>
      <button
        type="button"
        className="overlay-audit-info-btn"
        aria-label="Entry details"
        aria-expanded={open}
        title="Entry details"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <svg className="overlay-audit-info-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div className="overlay-audit-info-popover" role="region" aria-label="Entry audit details">
          <div className="overlay-audit-info-popover-title">Entry details</div>
          {enteredAt && (
            <div className="overlay-audit-info-row">
              <span className="overlay-audit-info-key">First entered</span>
              <span className="overlay-audit-info-val">{formatTs(enteredAt)}</span>
            </div>
          )}
          {lockedAt && (
            <div className="overlay-audit-info-row">
              <span className="overlay-audit-info-key">Submitted / locked</span>
              <span className="overlay-audit-info-val">{formatTs(lockedAt)}</span>
            </div>
          )}
          {recordedBy != null && recordedBy !== '' && (
            <div className="overlay-audit-info-row">
              <span className="overlay-audit-info-key">Recorded by</span>
              <span className="overlay-audit-info-val">{recordedBy}</span>
            </div>
          )}
          {correctionRef != null && (
            <div className="overlay-audit-info-row">
              <span className="overlay-audit-info-key">Correction ref</span>
              <span className="overlay-audit-info-val">#{correctionRef} (see Corrections panel for this page)</span>
            </div>
          )}
          {corrs.length > 0 && (
            <div className="overlay-audit-info-corrections">
              <div className="overlay-audit-info-key">Correction history</div>
              <ul className="overlay-audit-info-correction-list">
                {corrs.map((c, i) => (
                  <li key={i}>
                    <span className="overlay-audit-info-val">{formatTs(c.at)}</span>
                    <span className="overlay-audit-info-by"> — {c.by || '—'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function tableHeaderLabel(entity, idFallback) {
  const t = entity && typeof entity.label === 'string' ? entity.label.trim() : ''
  return t || idFallback
}

function TableFieldInput({
  field,
  value,
  onChange,
  disabled,
  readOnly,
  showRowColumnLabels = false,
  /** When true (PDF overlay), row/column weights fill the field frame like Form Builder preview. */
  fillParent = false,
}) {
  const { cells } = normalizeTableValue(value)
  const cols = field.tableColumns || []
  const rows = field.tableRows || []
  const { rowIds, colIds, covered, spanOf } = buildTableMergeLayout(field)

  const setCell = (key, text) => {
    if (readOnly) return
    onChange({ cells: { ...cells, [key]: text } })
  }

  if (!cols.length || !rows.length) {
    return (
      <p className="overlay-table-empty">This table has no rows or columns in the form definition.</p>
    )
  }

  const totalColW = cols.reduce((s, c) => s + tableColWidthPx(c), 0)
  const totalRowH = rows.reduce((s, r) => s + tableRowHeightPx(r), 0)

  const tableStyle = fillParent
    ? { tableLayout: 'fixed', width: '100%', height: '100%' }
    : { tableLayout: 'fixed', width: '100%' }

  const colWidthStyle = (c) => {
    if (fillParent && totalColW > 0) {
      return { width: `${(tableColWidthPx(c) / totalColW) * 100}%` }
    }
    return { width: tableColWidthPx(c) }
  }

  const rowHeightStyle = (row) => {
    if (fillParent && totalRowH > 0) {
      return { height: `${(tableRowHeightPx(row) / totalRowH) * 100}%` }
    }
    return { height: tableRowHeightPx(row) }
  }

  const tableClass = showRowColumnLabels
    ? 'overlay-table overlay-table-with-labels'
    : 'overlay-table overlay-table-data-only'

  return (
    <div className={`overlay-table-scroll${readOnly ? ' overlay-table-scroll-readonly' : ''}`}>
      <table className={tableClass} style={tableStyle}>
        <colgroup>
          {showRowColumnLabels && <col className="overlay-table-col-rowlabels" />}
          {cols.map((c) => (
            <col key={c.id} style={colWidthStyle(c)} />
          ))}
        </colgroup>
        {showRowColumnLabels && (
          <thead>
            <tr>
              <th scope="col" className="overlay-table-label-corner" aria-label="Row and column labels">
                {' '}
              </th>
              {colIds.map((colId) => {
                const col = cols.find((c) => c.id === colId)
                return (
                  <th key={colId} scope="col" className="overlay-table-col-header">
                    {tableHeaderLabel(col, colId)}
                  </th>
                )
              })}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id} style={rowHeightStyle(row)}>
              {showRowColumnLabels && (
                <th scope="row" className="overlay-table-row-header">
                  {tableHeaderLabel(row, row.id)}
                </th>
              )}
              {colIds.map((colId) => {
                const cellKey = tableCellKey(rowIds[ri], colId)
                if (covered.has(cellKey)) return null
                const span = spanOf.get(cellKey)
                const cellVal = cells[cellKey] ?? ''
                return (
                  <td key={cellKey} rowSpan={span?.rowspan || 1} colSpan={span?.colspan || 1}>
                    {readOnly ? (
                      <span className="overlay-table-input overlay-table-readonly">{cellVal || '\u00A0'}</span>
                    ) : (
                      <input
                        type="text"
                        className="overlay-table-input"
                        value={cellVal}
                        disabled={disabled}
                        onChange={(e) => setCell(cellKey, e.target.value)}
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Field renderer (with audit: timestamp, lock after 1 min, corrections) ─────
function OverlayField({
  field,
  entry,
  stageAccessible,
  onChange,
  onLockField,
  correctionRef,
  scale: currentScale = DESIGN_SCALE,
  readOnly = false,
  activeUsers = [],
  collaboratorSetupComplete = true,
  onFieldPanelToggle,
  fieldPanelActive = false,
}) {
  const stageLocked = !stageAccessible || readOnly
  const value = getEffectiveValue(entry)
  const fieldLocked = isFieldEntryLocked(entry)

  const scaleFactor = currentScale / DESIGN_SCALE
  const style = {
    left: field.x * scaleFactor,
    top: field.y * scaleFactor,
    width: field.width * scaleFactor,
    height: field.height * scaleFactor,
    ...overlayFieldFontStyle(field),
  }

  const compactShell = (className, inner) => (
    <div
      data-de-overlay-field={field.id}
      className={`overlay-field overlay-field--compact${fieldPanelActive ? ' overlay-field--panel-active' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onClick={(e) => {
        e.stopPropagation()
        onFieldPanelToggle?.(field.id)
      }}
    >
      {inner}
    </div>
  )

  const compactInputBase =
    'overlay-field-input-container overlay-field-input-container--compact' +
    (field.type === 'textarea' ? ' overlay-field-input-container--textarea' : '')

  // Batch complete / read-only: values on PDF are display-only
  if (stageLocked) {
    return compactShell(
      'locked',
      <div
        className={`${compactInputBase}${field.type === 'table' ? ' overlay-field-audit-table' : ''}`}
      >
        {field.type === 'table' ? (
          <TableFieldInput field={field} value={value} readOnly fillParent />
        ) : field.type === 'signature' ? (
          <ReadonlySignatureValue value={value} className="overlay-field-value-readonly overlay-field-value-readonly--compact" />
        ) : field.type === 'checkbox' ? (
          <ReadonlyCheckboxValue value={value} className="overlay-field-value-readonly overlay-field-value-readonly--compact" />
        ) : (
          <span
            className={`overlay-field-value-readonly overlay-field-value-readonly--compact${field.type === 'textarea' ? ' overlay-field-value-readonly--textarea' : ''}`}
          >
            {displayFieldValue(field, value)}
          </span>
        )}
      </div>,
    )
  }

  if (fieldLocked) {
    return compactShell(
      'overlay-field-locked',
      <div
        className={`${compactInputBase} overlay-field-locked-inner${field.type === 'table' ? ' overlay-field-audit-table' : ''}`}
      >
        {correctionRef != null && (
          <span className="overlay-field-ref-badge overlay-field-ref-badge--compact" title={`Correction #${correctionRef}`}>
            {correctionRef}
          </span>
        )}
        {field.type === 'table' ? (
          <TableFieldInput field={field} value={value} readOnly fillParent />
        ) : field.type === 'signature' ? (
          <ReadonlySignatureValue value={value} className="overlay-field-value-readonly overlay-field-value-readonly--compact" />
        ) : field.type === 'checkbox' ? (
          <ReadonlyCheckboxValue value={value} className="overlay-field-value-readonly overlay-field-value-readonly--compact" />
        ) : (
          <span
            className={`overlay-field-value-readonly overlay-field-value-readonly--compact${field.type === 'textarea' ? ' overlay-field-value-readonly--textarea' : ''}`}
          >
            {displayFieldValue(field, value)}
          </span>
        )}
      </div>,
    )
  }

  // Editable: normal input with optional entered-at timestamp
  let input
  switch (field.type) {
    case 'text':
      input = (
        <input
          type="text"
          placeholder={field.placeholder || ''}
          value={value ?? ''}
          disabled={stageLocked}
          onChange={e => onChange(field.id, e.target.value)}
        />
      )
      break
    case 'date':
      input = (
        <input
          type="date"
          value={value ?? ''}
          disabled={stageLocked}
          onChange={e => onChange(field.id, e.target.value)}
        />
      )
      break
    case 'number':
      input = field.unit ? (
        <div className="unit-input-group">
          <input
            type="number"
            placeholder={field.placeholder || ''}
            value={value ?? ''}
            disabled={stageLocked}
            onChange={e => onChange(field.id, e.target.value)}
          />
          <div className="unit-display">{field.unit}</div>
        </div>
      ) : (
        <input
          type="number"
          placeholder={field.placeholder || ''}
          value={value ?? ''}
          disabled={stageLocked}
          onChange={e => onChange(field.id, e.target.value)}
        />
      )
      break
    case 'textarea':
      input = (
        <div className="overlay-textarea-stack">
          <textarea
            placeholder={field.placeholder || ''}
            value={value ?? ''}
            disabled={stageLocked}
            onChange={e => onChange(field.id, e.target.value)}
          />
          {/* Print: native textarea paints text from the top of a full-height box; mirror uses flex bottom-align */}
          <div className="overlay-textarea-print-mirror" aria-hidden="true">
            {value ?? ''}
          </div>
        </div>
      )
      break
    case 'dropdown':
      input = (
        <select
          value={value ?? ''}
          disabled={stageLocked}
          onChange={e => onChange(field.id, e.target.value)}
        >
          <option value="">-- Select --</option>
          {(field.options || []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )
      break
    case 'checkbox': {
      const chk = value === true || value === 'true' || value === 1
      input = (
        <div className="overlay-checkbox-wrap overlay-checkbox-wrap--compact">
          <input
            type="checkbox"
            checked={chk}
            disabled={stageLocked}
            aria-label={field.label || 'Checkbox'}
            onChange={e => onChange(field.id, e.target.checked)}
          />
          <span
            className={`de-checkbox-print-visual${chk ? ' de-checkbox-print-visual--checked' : ''}`}
            aria-hidden="true"
          />
        </div>
      )
      break
    }
    case 'time': {
      const t = typeof value === 'string' ? value.slice(0, 5) : ''
      input = (
        <div className="overlay-time-row">
          <input
            type="time"
            placeholder={field.placeholder || ''}
            value={t}
            disabled={stageLocked}
            onChange={e => onChange(field.id, e.target.value)}
          />
          <button
            type="button"
            className="overlay-time-now-btn"
            disabled={stageLocked}
            onClick={() => {
              const d = new Date()
              onChange(
                field.id,
                `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
              )
            }}
          >
            Now
          </button>
        </div>
      )
      break
    }
    case 'radio':
      input = (
        <div className="overlay-radio-group">
          {(field.options || []).map(opt => (
            <label key={opt} className="overlay-radio-label">
              <input
                type="radio"
                name={`de-r-${field.id}`}
                value={opt}
                checked={value === opt}
                disabled={stageLocked}
                onChange={() => onChange(field.id, opt)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )
      break
    case 'multiselect': {
      const selected = parseMultiselectValue(value)
      input = (
        <div className="overlay-multiselect-group">
          {(field.options || []).map(opt => (
            <label key={opt} className="overlay-radio-label">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                disabled={stageLocked}
                onChange={() => {
                  const next = selected.includes(opt)
                    ? selected.filter(x => x !== opt)
                    : [...selected, opt]
                  onChange(field.id, next)
                }}
              />
              <span
                className={`de-checkbox-print-visual de-checkbox-print-visual--print-only${selected.includes(opt) ? ' de-checkbox-print-visual--checked' : ''}`}
                aria-hidden="true"
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )
      break
    }
    case 'signature':
      input = (
        <SignaturePad
          fieldId={field.id}
          width={field.width * scaleFactor}
          height={field.height * scaleFactor}
          disabled={stageLocked}
          value={value ?? ''}
          onChange={val => onChange(field.id, val)}
        />
      )
      break
    case 'collaborator': {
      const cv = collaboratorDraft(value)
      const opts = activeUsers.filter((u) => u.active !== false)
      input = (
        <div className="overlay-collaborator overlay-collaborator--compact">
          <label className="overlay-collab-label">
            Primary analyst
            <select
              value={cv.primaryUserId}
              disabled={stageLocked}
              onChange={(e) =>
                onChange(field.id, { ...cv, primaryUserId: e.target.value })
              }
            >
              <option value="">— Select —</option>
              {opts.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="overlay-collab-label">
            Secondary reviewer
            <select
              value={cv.secondaryUserId}
              disabled={stageLocked}
              onChange={(e) =>
                onChange(field.id, { ...cv, secondaryUserId: e.target.value })
              }
            >
              <option value="">— Select —</option>
              {opts.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="overlay-collab-check">
            <input
              type="checkbox"
              checked={!!cv.reviewerIsDesignatedRecorder}
              disabled={stageLocked}
              onChange={(e) =>
                onChange(field.id, { ...cv, reviewerIsDesignatedRecorder: e.target.checked })
              }
            />
            Secondary reviewer is the designated recorder for all data entry
          </label>
        </div>
      )
      break
    }
    case 'table':
      input = (
        <TableFieldInput
          field={field}
          value={value}
          onChange={(next) => onChange(field.id, next)}
          disabled={stageLocked}
          fillParent
        />
      )
      break
    default:
      input = (
        <input
          type="text"
          value={value ?? ''}
          disabled={stageLocked}
          onChange={e => onChange(field.id, e.target.value)}
        />
      )
  }

  const blockedByCollaborator =
    field.type !== 'collaborator' && !collaboratorSetupComplete

  const canSubmitOverlay =
    isFieldValueFilled(field, value) && !fieldLocked && !stageLocked && !blockedByCollaborator

  const handleOverlayKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (!canSubmitOverlay || !onLockField) return
    if (e.target.closest?.('button')) return
    if (e.target.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    e.stopPropagation()
    onLockField(field.id)
  }

  const compactEmpty = !isFieldValueFilled(field, value)

  return compactShell(
    compactEmpty ? 'overlay-field--compact-empty' : '',
    <div
      className={compactInputBase}
      onKeyDown={handleOverlayKeyDown}
    >
      {blockedByCollaborator && (
        <p className="overlay-collab-block-hint">Complete the Collaborator Entry field first.</p>
      )}
      {input}
    </div>,
  )
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function DataEntry() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const pdfRef = useRef(null)
  /** Set before goToPage: open this field after the PDF paints (runs after page-change effect clears the panel). */
  const pendingStageFieldFocusRef = useRef(null)
  const { prefs, mergePrefs } = useUserPrefs()
  const displayName = useMemo(() => (prefs.ebrUserDisplayName || '').trim(), [prefs.ebrUserDisplayName])

  const formId = searchParams.get('form')
  const pdfParam = searchParams.get('pdf')
  const batchId = searchParams.get('batch')

  const [formConfig, setFormConfig] = useState(null)
  const [formData, setFormData] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [saving, setSaving] = useState(false)
  const [scale, setScale] = useState(1.5)

  // Batch creation state
  const [batchTitle, setBatchTitle] = useState('')
  const [batchDesc, setBatchDesc] = useState('')
  const [creatingBatch, setCreatingBatch] = useState(false)

  // Batch record when viewing by batchId (status, prefill formData, completed = read-only)
  const [batchRecord, setBatchRecord] = useState(null)
  const [isCompleted, setIsCompleted] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  /** Field whose definition/value panel is open (Form Builder label + metadata + actions). */
  const [fieldInfoPanelId, setFieldInfoPanelId] = useState(null)
  /** Inline position for fixed panel so it lines up with the overlay field on screen. */
  const [fieldPanelAnchorStyle, setFieldPanelAnchorStyle] = useState(null)

  // Load form config
  useEffect(() => {
    if (!formId && !pdfParam) { setLoading(false); return }
    setLoading(true)
    setError(null)
    const p = formId ? loadFormById(formId) : loadFormByPdf(pdfParam)
    p.then(res => {
      if (!res.success || !res.form) throw new Error('Form configuration not found')
      setFormConfig(res.form)

      mergePrefs((prev) => {
        const key = `${res.form.name || ''}|${res.form.pdfFile || ''}`
        const ver = res.form.version || 1
        const lastSeen =
          prev.ebrFormLastSeen && typeof prev.ebrFormLastSeen === 'object' && !Array.isArray(prev.ebrFormLastSeen)
            ? { ...prev.ebrFormLastSeen }
            : {}
        if (!lastSeen[key] || lastSeen[key] < ver) lastSeen[key] = ver
        const raw = prev.ebrRecentlyUsed
        const list = Array.isArray(raw) ? raw : []
        const entry = {
          formId: res.form.id,
          formName: res.form.name || 'Unnamed',
          pdfFile: res.form.pdfFile || '',
          openedAt: new Date().toISOString(),
        }
        const merged = [entry, ...list.filter((x) => x.formId !== res.form.id)].slice(0, 30)
        return { ...prev, ebrFormLastSeen: lastSeen, ebrRecentlyUsed: merged }
      })
    })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [formId, pdfParam, mergePrefs])

  // Load batch record when batchId is present (prefill formData, detect completed = read-only)
  useEffect(() => {
    if (!batchId || !formConfig) return
    setBatchLoading(true)
    getBatchRecord(batchId)
      .then((res) => {
        if (res.success && res.batch) {
          setBatchRecord(res.batch)
          setIsCompleted((res.batch.status || '') === 'completed')
          if (res.formData && typeof res.formData === 'object') {
            setFormData(res.formData)
          }
        }
      })
      .catch(() => { })
      .finally(() => setBatchLoading(false))
  }, [batchId, formConfig?.id])

  const [batchIdCopied, setBatchIdCopied] = useState(false)

  const copyBatchIdToClipboard = useCallback(async () => {
    const id = String(batchRecord?.batchId ?? batchId ?? '').trim()
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = id
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        return
      }
    }
    setBatchIdCopied(true)
    window.setTimeout(() => setBatchIdCopied(false), 2000)
  }, [batchRecord?.batchId, batchId])

  /* Print: scope layout fixes to this route only (see DataEntry.css @media print + html class) */
  useEffect(() => {
    document.documentElement.classList.add('de-data-entry-print-host')
    return () => document.documentElement.classList.remove('de-data-entry-print-host')
  }, [])

  // Derived data: effective values for validation (handles audit object shape)
  const formDataEffective = useMemo(() => {
    if (!formConfig?.fields) return {}
    return Object.fromEntries(formConfig.fields.map(f => [f.id, getEffectiveValue(formData[f.id])]))
  }, [formConfig, formData])

  const stages = useMemo(() => buildStages(formConfig?.fields), [formConfig])
  const stageCompletion = useMemo(() => computeStageCompletion(stages, formDataEffective), [stages, formDataEffective])
  const canComplete = useMemo(() => allRequiredFilled(formConfig?.fields, formDataEffective), [formConfig, formDataEffective])

  const currentPageFields = useMemo(() => {
    if (!formConfig?.fields) return []
    return getPageFieldsSpatialOrder(formConfig.fields, currentPage)
  }, [formConfig, currentPage])

  const fieldInfoPanelField = useMemo(() => {
    if (!fieldInfoPanelId || !formConfig?.fields) return null
    const f = formConfig.fields.find((x) => x.id === fieldInfoPanelId)
    if (!f || (f.page || 1) !== currentPage) return null
    return f
  }, [fieldInfoPanelId, formConfig?.fields, currentPage])

  /** Open the right-side field panel; close only via the panel close control (or page change). */
  const openFieldPanel = useCallback((fieldId) => {
    setFieldInfoPanelId(fieldId)
  }, [])

  useEffect(() => {
    setFieldInfoPanelId(null)
    setEditingCorrectionId(null)
    setCorrectionDraft(null)
  }, [currentPage])

  useLayoutEffect(() => {
    if (!fieldInfoPanelId) {
      setFieldPanelAnchorStyle(null)
      return
    }
    const measure = () => {
      setFieldPanelAnchorStyle(computeFieldPanelAnchorStyle(fieldInfoPanelId))
    }
    measure()
    const node = document.querySelector(overlayFieldSelector(fieldInfoPanelId))
    const ro = new ResizeObserver(measure)
    if (node) ro.observe(node)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    const t = window.setTimeout(measure, 100)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      window.clearTimeout(t)
    }
  }, [fieldInfoPanelId, scale, currentPage])

  const fieldPanelStageAccessible = useMemo(() => {
    if (!fieldInfoPanelField) return true
    const sn = fieldInfoPanelField.stageInProcess || 'Default Stage'
    const st = stages.find((s) => s.stage === sn)
    return st ? isStageAccessible(st, stages, stageCompletion) : true
  }, [fieldInfoPanelField, stages, stageCompletion])

  const { refMap: correctionRefMap, list: correctionList } = useCorrectionRefs(
    formConfig?.fields,
    formData,
    currentPage,
  )

  const formatTs = useCallback((iso) => {
    if (!iso) return ''
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
    } catch {
      return iso
    }
  }, [])

  const lastActivityRef = useRef({})
  const [editingCorrectionId, setEditingCorrectionId] = useState(null)
  /** Draft value while correcting a locked field (Field detail panel only). */
  const [correctionDraft, setCorrectionDraft] = useState(null)
  const [activeUsers, setActiveUsers] = useState([])
  const [recorderModalFieldId, setRecorderModalFieldId] = useState(null)
  const [correctionModal, setCorrectionModal] = useState(null)
  const [editorRole, setEditorRole] = useState('primary')
  const [editorOther, setEditorOther] = useState('')
  const [completeModalOpen, setCompleteModalOpen] = useState(false)
  const [completeSignOffChecked, setCompleteSignOffChecked] = useState(false)
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false)
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState(null)
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false)
  const [pdfPreviewError, setPdfPreviewError] = useState(null)
  const [pdfPreviewFilename, setPdfPreviewFilename] = useState('batch.pdf')

  const formConfigRef = useRef(null)
  formConfigRef.current = formConfig
  const activeUsersRef = useRef([])
  activeUsersRef.current = activeUsers
  const batchIdRef = useRef(batchId)
  batchIdRef.current = batchId

  useEffect(() => {
    if (!formConfig?.fields?.some((f) => f.type === 'collaborator')) return
    listActiveUsers()
      .then((r) => {
        if (r.success && Array.isArray(r.users)) setActiveUsers(r.users)
      })
      .catch(() => { })
  }, [formConfig?.id])

  const userIdToName = useMemo(
    () => Object.fromEntries(activeUsers.map((u) => [u.id, u.displayName])),
    [activeUsers],
  )

  const collaboratorPolicy = useMemo(
    () => getCollaboratorPolicy(formConfig, formData, userIdToName),
    [formConfig, formData, userIdToName],
  )

  const firstCollabField = useMemo(
    () => formConfig?.fields?.find((f) => f.type === 'collaborator'),
    [formConfig],
  )
  const collaboratorSetupComplete =
    !firstCollabField || isFieldEntryLocked(formData[firstCollabField.id])

  function idToNameMap() {
    return Object.fromEntries(activeUsersRef.current.map((u) => [u.id, u.displayName]))
  }

  // Field change handler: store as audit object with timestamp on first entry
  const handleFieldChange = useCallback((id, value) => {
    lastActivityRef.current[id] = Date.now()
    setFormData((prev) => {
      const field = formConfigRef.current?.fields?.find((f) => f.id === id)
      if (
        field?.type === 'collaborator' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const existing = prev[id]
        const prevV = isFieldEntryObject(existing) ? collaboratorDraft(existing.v) : collaboratorDraft()
        const merged = { ...prevV, ...value }
        return { ...prev, [id]: normalizeEntry(existing, merged, { setEnteredAt: true }) }
      }
      if (
        field?.type === 'table' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.cells
      ) {
        const existing = prev[id]
        const prevV = normalizeTableValue(isFieldEntryObject(existing) ? existing.v : existing)
        const merged = { cells: { ...prevV.cells, ...value.cells } }
        return { ...prev, [id]: normalizeEntry(existing, merged, { setEnteredAt: true }) }
      }
      const existing = prev[id]
      const normalized = normalizeEntry(existing, value, { setEnteredAt: true })
      return { ...prev, [id]: normalized }
    })
  }, [])

  const formDataRef = useRef(formData)
  formDataRef.current = formData

  // Idle lock: after 1 min without editing (skipped when per-entry recorder mode is on)
  useEffect(() => {
    if (!formConfig?.fields?.length) return
    const interval = setInterval(() => {
      const current = formDataRef.current
      const cfg = formConfigRef.current
      const now = Date.now()
      const policy = getCollaboratorPolicy(cfg, current, idToNameMap())
      const perEntryNoRecorder = policy && !policy.reviewerIsDesignatedRecorder
      let next = null
      cfg.fields.forEach((f) => {
        const id = f.id
        if (f.type === 'collaborator') return
        const entry = current[id]
        if (!entry) return
        const effective = getEffectiveValue(entry)
        if (f.type === 'multiselect' && parseMultiselectValue(effective).length === 0) return
        if (f.type === 'table' && isTableFieldEmpty(f, effective)) return
        if (
          effective === undefined ||
          effective === null ||
          effective === '' ||
          (typeof effective === 'object' &&
            !Array.isArray(effective) &&
            Object.keys(effective).length === 0)
        ) {
          return
        }
        if (isFieldEntryLocked(entry)) return
        if (perEntryNoRecorder) return
        const last = lastActivityRef.current[id] ?? 0
        if (now - last >= IDLE_LOCK_MS) {
          if (!next) next = { ...current }
          const recordedBy =
            policy && policy.reviewerIsDesignatedRecorder ? policy.secondaryName : undefined
          next[id] = normalizeEntry(entry, effective, {
            setEnteredAt: false,
            setLockedAt: true,
            recordedBy,
          })
        }
      })
      if (next) setFormData(next)
    }, 10000)
    return () => clearInterval(interval)
  }, [formConfig?.fields])

  const handleSaveCorrectionRequest = useCallback((fieldId, newValue) => {
    setEditorRole('primary')
    const pol = getCollaboratorPolicy(
      formConfigRef.current,
      formDataRef.current,
      idToNameMap(),
    )
    setEditorOther(pol ? '' : displayName)
    setCorrectionModal({ fieldId, newValue })
  }, [displayName])

  const confirmCorrectionSave = useCallback(() => {
    if (!correctionModal) return
    const policy = getCollaboratorPolicy(
      formConfigRef.current,
      formDataRef.current,
      idToNameMap(),
    )
    let by = ''
    if (policy) {
      if (editorRole === 'primary') by = policy.primaryName
      else if (editorRole === 'secondary') by = policy.secondaryName
      else by = editorOther.trim()
    } else {
      by = editorOther.trim() || displayName
    }
    if (!by) {
      window.alert('Specify who is making this edit.')
      return
    }
    const { fieldId, newValue } = correctionModal
    const correctedAt = new Date().toISOString()
    setFormData((prev) => ({
      ...prev,
      [fieldId]: addCorrection(prev[fieldId], newValue, by, correctedAt),
    }))
    setEditingCorrectionId(null)
    setCorrectionDraft(null)
    setCorrectionModal(null)
    setEditorOther('')
  }, [correctionModal, editorRole, editorOther, displayName])

  const handleLockField = useCallback((fieldId) => {
    const field = formConfigRef.current?.fields?.find((f) => f.id === fieldId)
    const fd = formDataRef.current
    const entry = fd[fieldId]
    const effective = getEffectiveValue(entry)

    if (field?.type === 'collaborator') {
      if (!isFieldValueFilled(field, effective)) {
        window.alert(
          'Select a primary analyst and secondary reviewer (two different active users).',
        )
        return
      }
      const cv = collaboratorDraft(effective)
      const map = idToNameMap()
      const v = {
        ...cv,
        primaryDisplayName: map[cv.primaryUserId] || cv.primaryUserId,
        secondaryDisplayName: map[cv.secondaryUserId] || cv.secondaryUserId,
      }
      setFormData((prev) => ({
        ...prev,
        [fieldId]: normalizeEntry(prev[fieldId], v, { setEnteredAt: false, setLockedAt: true }),
      }))
      return
    }

    if (field?.type === 'table' && isRequired(field) && !isFieldValueFilled(field, effective)) {
      window.alert('Fill all cells in this table before submitting.')
      return
    }

    if (
      effective === undefined ||
      effective === null ||
      effective === '' ||
      (fIsEmptyEffective(field, effective))
    ) {
      return
    }
    if (isFieldEntryLocked(entry)) return

    const policy = getCollaboratorPolicy(formConfigRef.current, fd, idToNameMap())
    if (policy && !policy.reviewerIsDesignatedRecorder) {
      setRecorderModalFieldId(fieldId)
      return
    }
    const recordedBy = policy && policy.reviewerIsDesignatedRecorder ? policy.secondaryName : undefined
    setFormData((prev) => {
      const ent = prev[fieldId]
      const eff = getEffectiveValue(ent)
      if (isFieldEntryLocked(ent)) return prev
      return {
        ...prev,
        [fieldId]: normalizeEntry(ent, eff, {
          setEnteredAt: false,
          setLockedAt: true,
          recordedBy: recordedBy || undefined,
        }),
      }
    })
  }, [])

  const handleStartCorrection = useCallback((fieldId) => {
    if (fieldId == null) {
      setEditingCorrectionId(null)
      setCorrectionDraft(null)
      return
    }
    setFieldInfoPanelId(fieldId)
    setEditingCorrectionId(fieldId)
    const field = formConfig?.fields?.find((f) => f.id === fieldId)
    if (field) {
      const v = getEffectiveValue(formData[fieldId])
      setCorrectionDraft(initializeCorrectionDraft(field, v))
    }
  }, [formConfig, formData])

  function fIsEmptyEffective(field, effective) {
    if (field?.type === 'multiselect') return parseMultiselectValue(effective).length === 0
    if (field?.type === 'checkbox')
      return effective !== true && effective !== 'true' && effective !== 1
    if (field?.type === 'table') return isTableFieldEmpty(field, effective)
    return false
  }

  const confirmRecorderLock = useCallback((role) => {
    const fieldId = recorderModalFieldId
    if (!fieldId) return
    const policy = getCollaboratorPolicy(
      formConfigRef.current,
      formDataRef.current,
      idToNameMap(),
    )
    if (!policy) {
      setRecorderModalFieldId(null)
      return
    }
    const name = role === 'primary' ? policy.primaryName : policy.secondaryName
    setFormData((prev) => {
      const ent = prev[fieldId]
      const eff = getEffectiveValue(ent)
      if (isFieldEntryLocked(ent)) return prev
      return {
        ...prev,
        [fieldId]: normalizeEntry(ent, eff, {
          setEnteredAt: false,
          setLockedAt: true,
          recordedBy: name,
        }),
      }
    })
    setRecorderModalFieldId(null)
  }, [recorderModalFieldId])

  const [pdfPageSize, setPdfPageSize] = useState({ width: 0, height: 0 })
  /** Saved when changing pages; applied in onPageRendered after the new page paints. */
  const pendingWindowScrollRestoreRef = useRef(null)

  const onPageRendered = useCallback(({ page, totalPages: n, width, height }) => {
    setCurrentPage(page)
    if (n != null) setTotalPages(n)
    if (width > 0 && height > 0) setPdfPageSize({ width, height })

    const pend = pendingStageFieldFocusRef.current
    if (pend && pend.page === page) {
      pendingStageFieldFocusRef.current = null
      const { fieldId } = pend
      window.setTimeout(() => {
        setFieldInfoPanelId(fieldId)
        document.querySelector(overlayFieldSelector(fieldId))?.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth',
        })
      }, 0)
    }

    const savedY = pendingWindowScrollRestoreRef.current
    if (savedY != null && typeof window !== 'undefined') {
      pendingWindowScrollRestoreRef.current = null
      const apply = () => window.scrollTo(0, savedY)
      apply()
      queueMicrotask(apply)
      requestAnimationFrame(() => {
        apply()
        requestAnimationFrame(() => {
          apply()
          setTimeout(apply, 0)
          setTimeout(apply, 16)
          setTimeout(apply, 50)
          setTimeout(apply, 100)
          setTimeout(apply, 200)
          setTimeout(apply, 400)
        })
      })
    }
  }, [])


  const goToPdfPage = useCallback((page) => {
    if (typeof window !== 'undefined') {
      pendingWindowScrollRestoreRef.current = window.scrollY
    }
    pdfRef.current?.goToPage?.(page)
  }, [])

  /** Stages card: go to next unfilled field in that stage (document order), or first field if all filled. */
  const focusStageNextField = useCallback(
    (stage) => {
      if (!formConfig?.fields?.length) return
      const target = findTargetFieldForStageNavigation(formConfig.fields, stage.stage, formData)
      if (!target) return
      const page = target.page || 1
      if (page === currentPage) {
        setFieldInfoPanelId(target.id)
        window.requestAnimationFrame(() => {
          document.querySelector(overlayFieldSelector(target.id))?.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
          })
        })
      } else {
        pendingStageFieldFocusRef.current = { fieldId: target.id, page }
        goToPdfPage(page)
      }
    },
    [formConfig, formData, currentPage, goToPdfPage],
  )

  /** Persist current entry to the server (same payload as Save). Used by Save and before Mark complete. */
  const persistFormData = useCallback(
    async ({ silentSuccess = false }) => {
      if (!formConfig) {
        alert('Form is not loaded yet.')
        return { ok: false }
      }
      // Always read from formDataRef so we save the latest values even if React state has not
      // re-rendered yet (common when clicking Save / Mark complete right after editing).
      const snapshot = { ...formDataRef.current }
      const effectiveMap = Object.fromEntries(
        (formConfig.fields || []).map((f) => [f.id, getEffectiveValue(snapshot[f.id])]),
      )
      const errors = []
      formConfig.fields.forEach((f) => {
        if (isRequired(f) && !isFieldValueFilled(f, effectiveMap[f.id])) {
          errors.push(f.label || f.id)
        }
      })
      if (errors.length) {
        alert('Please fill in all required fields:\n- ' + errors.join('\n- '))
        return { ok: false }
      }
      const stageCompletionPayload = computeStageCompletion(stages, effectiveMap)
      const bid = batchIdRef.current || batchId
      const body = {
        formId: formConfig.id,
        formName: formConfig.name,
        pdfFile: formConfig.pdfFile,
        data: snapshot,
        stageCompletion: stageCompletionPayload,
        stages: stages.map((s) => ({ stage: s.stage, order: s.order })),
        savedAt: new Date().toISOString(),
      }
      if (bid) body.batchId = bid
      if (isEbrApiDebug()) {
        const dk = snapshot && typeof snapshot === 'object' ? Object.keys(snapshot) : []
        console.debug('[EBR DataEntry] persist form data', {
          formId: formConfig.id,
          batchId: bid || null,
          dataKeysCount: dk.length,
          stagesCount: stages.length,
          silentSuccess,
        })
      }
      try {
        const res = await saveData(body)
        if (!res.success) {
          alert('Error saving data: ' + (res.message || 'Unknown error'))
          return { ok: false }
        }
        if (!silentSuccess) alert('Data saved successfully!')
        return { ok: true, res }
      } catch (err) {
        alert('Error saving data: ' + err.message)
        return { ok: false }
      }
    },
    [formConfig, stages, batchId],
  )

  const handleSave = useCallback(async () => {
    if (!formConfig) return
    setSaving(true)
    try {
      await persistFormData({ silentSuccess: false })
    } finally {
      setSaving(false)
    }
  }, [formConfig, persistFormData])

  useEffect(() => {
    return () => {
      if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl)
    }
  }, [pdfPreviewUrl])

  const handleClosePdfPreview = useCallback(() => {
    setPdfPreviewOpen(false)
    setPdfPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setPdfPreviewError(null)
    setPdfPreviewLoading(false)
  }, [])

  const handleOpenPdfPreview = useCallback(async () => {
    if (!formConfig) return
    setPdfPreviewError(null)
    setPdfPreviewOpen(true)
    setPdfPreviewLoading(true)
    setPdfPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    const safeName = `${(batchRecord?.title || formConfig.name || 'batch').replace(/[^\w-]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`
    setPdfPreviewFilename(safeName)
    try {
      const blob = await exportBatchPdfBlob({
        formId: formConfig.id,
        pdfFile: formConfig.pdfFile,
        data: formData,
        batch: {
          title: batchRecord?.title || formConfig.name,
          completedSignOffBy: batchRecord?.completedSignOffBy,
          completedSignOffAt: batchRecord?.completedSignOffAt,
          completedAt: batchRecord?.completedAt,
        },
      })
      setPdfPreviewUrl(URL.createObjectURL(blob))
    } catch (err) {
      setPdfPreviewError(err.message || 'Could not generate PDF')
    } finally {
      setPdfPreviewLoading(false)
    }
  }, [formConfig, formData, batchRecord])

  const handleDownloadPdfFromPreview = useCallback(() => {
    if (!pdfPreviewUrl) return
    const a = document.createElement('a')
    a.href = pdfPreviewUrl
    a.download = pdfPreviewFilename
    a.click()
  }, [pdfPreviewUrl, pdfPreviewFilename])

  const runCompleteBatch = useCallback(
    async (extra = {}) => {
      const effectiveBatchId = batchIdRef.current || batchId
      if (!effectiveBatchId) {
        alert('No batch record is open. Create or open a batch before marking complete.')
        return
      }
      setSaving(true)
      try {
        const saved = await persistFormData({ silentSuccess: true })
        if (!saved.ok) return

        const payload = { batchId: effectiveBatchId, status: 'completed', ...extra }
        if (isEbrApiDebug()) {
          console.debug('[EBR DataEntry] mark complete', {
            batchId: effectiveBatchId,
            extraKeys: Object.keys(extra),
            hasSignOff: !!(extra.completedSignOffBy || extra.completedSignOffAt),
          })
        }
        const res = await updateBatchRecord(payload)
        if (res.success) {
          navigate('/batch?filter=completed')
        } else {
          alert('Error: ' + (res.message || 'Unknown error'))
        }
      } catch (err) {
        alert('Error completing batch: ' + err.message)
      } finally {
        setSaving(false)
      }
    },
    [batchId, navigate, persistFormData],
  )

  const handleComplete = useCallback(async () => {
    if (!batchId) return
    if (collaboratorPolicy) {
      setCompleteSignOffChecked(false)
      setCompleteModalOpen(true)
      return
    }
    if (!window.confirm('Mark this batch record as complete? This cannot be undone.')) return
    await runCompleteBatch()
  }, [batchId, collaboratorPolicy, runCompleteBatch])

  const confirmSecondarySignOff = useCallback(async () => {
    if (!completeSignOffChecked || !collaboratorPolicy) {
      window.alert('Confirm that the secondary reviewer is signing off on this batch.')
      return
    }
    setCompleteModalOpen(false)
    setCompleteSignOffChecked(false)
    await runCompleteBatch({
      completedSignOffBy: collaboratorPolicy.secondaryName,
      completedSignOffAt: new Date().toISOString(),
    })
  }, [completeSignOffChecked, collaboratorPolicy, runCompleteBatch])

  // Create batch
  const handleCreateBatch = useCallback(async () => {
    if (!batchTitle.trim()) { alert('Title is required'); return }
    setCreatingBatch(true)
    try {
      const res = await createBatchRecord({
        formId: formConfig.id,
        formName: formConfig.name,
        pdfFile: formConfig.pdfFile || '',
        title: batchTitle.trim(),
        description: batchDesc.trim(),
        createdBy: displayName,
      })
      if (res.success && res.batchId) {
        const params = new URLSearchParams(searchParams)
        params.set('batch', res.batchId)
        navigate(`/forms/entry?${params.toString()}`)
      } else {
        alert('Error creating batch: ' + (res.message || 'Unknown error'))
      }
    } catch (err) {
      alert('Error creating batch: ' + err.message)
    } finally {
      setCreatingBatch(false)
    }
  }, [batchTitle, batchDesc, formConfig, searchParams, navigate, displayName])

  // ─── No form specified ─────────────────────────────────────────────────
  if (!formId && !pdfParam) {
    return (
      <div className="data-entry-page">
        <div className="de-header"><h1>Data Entry</h1></div>
        <div className="de-error">No form specified. Select a form from <a href="/forms">Batch Record Forms</a> or the dashboard.</div>
      </div>
    )
  }

  if (loading) return <div className="data-entry-page"><div className="de-loading">Loading form configuration...</div></div>
  if (error) return <div className="data-entry-page"><div className="de-header"><h1>Data Entry</h1></div><div className="de-error">{error}</div></div>
  if (!formConfig) return <div className="data-entry-page"><div className="de-error">Form not found.</div></div>

  // ─── Batch creation panel ──────────────────────────────────────────────
  if (formId && !batchId) {
    return (
      <div className="data-entry-page">
        <div className="de-header"><h1>Data Entry &mdash; {formConfig.name}</h1></div>

        {/* Form info */}
        <div className="de-card">
          <h2>{formConfig.name}</h2>
          {formConfig.description && <p>{formConfig.description}</p>}
          <p><strong>PDF:</strong> {formConfig.pdfFile}</p>
          <p><strong>Fields:</strong> {formConfig.fields?.length ?? 0}</p>
          {formConfig.isCombined && (
            <div className="combined-note">
              <strong>Combined Form</strong>
              This batch is made from {formConfig.sourceFormIds?.length ?? 0} source form(s). All data will be saved as a single batch record.
            </div>
          )}
        </div>

        {/* Create batch */}
        <div className="de-card batch-create-panel">
          <h2>New Batch Record</h2>
          <div className="form-group">
            <label htmlFor="batch-title">Title *</label>
            <input
              id="batch-title"
              type="text"
              placeholder="Batch record title"
              value={batchTitle}
              onChange={e => setBatchTitle(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="batch-desc">Description</label>
            <textarea
              id="batch-desc"
              rows={3}
              placeholder="Optional description"
              value={batchDesc}
              onChange={e => setBatchDesc(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" disabled={creatingBatch || !batchTitle.trim()} onClick={handleCreateBatch}>
            {creatingBatch ? 'Creating...' : 'Create and Start'}
          </button>
        </div>
      </div>
    )
  }

  // ─── Main data entry view ──────────────────────────────────────────────
  const completeTitle = canComplete ? 'Mark this batch record as complete' : 'Fill all required fields to enable'

  return (
    <div className="data-entry-page">
      {/* Header */}
      <div className="de-header">
        <h1>Data Entry &mdash; {formConfig.name}</h1>
        <div className="de-header-actions">
          {isCompleted ? (
            <button
              type="button"
              className="btn btn-download-pdf"
              disabled={pdfPreviewLoading}
              onClick={handleOpenPdfPreview}
            >
              {pdfPreviewLoading ? 'Preparing PDF…' : 'Preview PDF'}
            </button>
          ) : (
            <>
              <button className="btn btn-save" disabled={saving} onClick={handleSave}>
                {saving ? 'Saving...' : 'Save Data'}
              </button>
              {batchId && (
                <button className="btn btn-complete" disabled={!canComplete} title={completeTitle} onClick={handleComplete}>
                  Mark as Complete
                </button>
              )}
              <button
                type="button"
                className="btn btn-download-pdf"
                disabled={pdfPreviewLoading}
                onClick={handleOpenPdfPreview}
              >
                {pdfPreviewLoading ? 'Preparing PDF…' : 'Preview PDF'}
              </button>
            </>
          )}
        </div>
      </div>

      {batchId && (
        <div className="de-batch-meta">
          {batchLoading && !batchRecord ? (
            <p className="de-batch-meta-loading">Loading batch…</p>
          ) : batchRecord?.title ? (
            <p className="de-batch-meta-title">
              <strong>Batch:</strong> {batchRecord.title}
            </p>
          ) : null}
          <div className="de-batch-meta-id-row">
            <span className="de-batch-meta-label">Batch ID</span>
            <code className="de-batch-id">{batchRecord?.batchId ?? batchId}</code>
            <button
              type="button"
              className="de-batch-id-copy"
              onClick={copyBatchIdToClipboard}
              aria-label="Copy batch ID to clipboard"
            >
              {batchIdCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {firstCollabField && !collaboratorSetupComplete && batchId && !isCompleted && (
        <div className="de-collab-banner" role="status">
          <strong>Collaborator setup required:</strong> complete &ldquo;{firstCollabField.label || 'Collaborator Entry'}&rdquo;
          (primary analyst + secondary reviewer) before you can submit other fields.
        </div>
      )}

      <div className="de-layout de-layout-single">
        {/* Form info + Stages: 50/50 on one row when stages exist */}
        <div className={stages.length > 0 ? 'de-form-and-stages-row' : ''}>
          <div className="de-card de-form-info">
            <h2>{formConfig.name}</h2>
            {formConfig.description && <p>{formConfig.description}</p>}
            <p><strong>PDF:</strong> {formConfig.pdfFile}</p>
            <p><strong>Fields:</strong> {formConfig.fields?.length ?? 0}</p>
            {collaboratorPolicy && (
              <p className="de-collab-summary">
                <strong>Collaborators:</strong> Primary {collaboratorPolicy.primaryName}; Reviewer{' '}
                {collaboratorPolicy.secondaryName}
                {collaboratorPolicy.reviewerIsDesignatedRecorder
                  ? ' (reviewer records all entry)'
                  : ' (recorder chosen per field on Submit)'}
              </p>
            )}
            {formConfig.isCombined && (
              <div className="combined-note">
                <strong>Combined Form</strong>
                This batch is made from {formConfig.sourceFormIds?.length ?? 0} source form(s). All data will be saved as a single batch record.
              </div>
            )}
          </div>
          {stages.length > 0 && (
            <div className="de-card stages-panel">
              <h3>Stages</h3>
              <p className="stages-panel-hint">Click a stage to open the next unfilled field on the form (or the first field if that stage is complete).</p>
              {stages.map(stage => {
                const completed = stageCompletion[stage.stage]
                const accessible = isStageAccessible(stage, stages, stageCompletion)
                const isCurrent = accessible && !completed
                let cls = ''
                if (completed) cls = 'completed'
                else if (isCurrent) cls = 'current'
                else if (!accessible) cls = 'locked'

                return (
                  <div
                    key={stage.stage}
                    role="button"
                    tabIndex={0}
                    className={`stage-item stage-item--nav${cls ? ` ${cls}` : ''}`}
                    onClick={() => focusStageNextField(stage)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        focusStageNextField(stage)
                      }
                    }}
                  >
                    <div className="stage-info">
                      <div className="stage-name">{stage.stage}</div>
                      <div className="stage-order">
                        {stage.order != null ? `Order: ${stage.order}` : 'No order'} &bull; {stage.fields.length} field(s)
                      </div>
                    </div>
                    <div className={`stage-status ${cls}`}>
                      {completed && '\u2713 Completed'}
                      {isCurrent && '\u2192 Current'}
                      {!accessible && !completed && '\uD83D\uDD12 Locked'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* PDF + corrections: row layout; corrections column is card stack (not full page height) */}
        <div className="de-pdf-and-corrections">
          <div className="de-pdf-area">
            <div className="de-pdf-viewport">
              <div className="de-pdf-page-and-corrections">
                <PdfViewer
                  ref={pdfRef}
                  pdfUrl={`/uploads/${formConfig.pdfFile}`}
                  scale={scale}
                  onPageRendered={onPageRendered}
                  paginationPosition="both"
                  hidePagination={totalPages <= 1}
                  zoomControls={
                    <PdfZoomControls
                      className="de-zoom-controls"
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
                  {currentPageFields.map(field => {
                    const stageName = field.stageInProcess || 'Default Stage'
                    const stage = stages.find(s => s.stage === stageName)
                    const accessible = stage ? isStageAccessible(stage, stages, stageCompletion) : true
                    return (
                      <OverlayField
                        key={field.id}
                        field={field}
                        entry={formData[field.id]}
                        stageAccessible={accessible}
                        correctionRef={correctionRefMap[field.id]}
                        scale={scale}
                        onChange={handleFieldChange}
                        onLockField={handleLockField}
                        readOnly={isCompleted}
                        activeUsers={activeUsers}
                        collaboratorSetupComplete={collaboratorSetupComplete}
                        onFieldPanelToggle={openFieldPanel}
                        fieldPanelActive={fieldInfoPanelId === field.id}
                      />
                    )
                  })}
                </PdfViewer>
                {correctionList.length > 0 && (
                  <aside
                    className="de-corrections-panel-aside"
                    style={{
                      maxHeight: pdfPageSize.height > 0 ? `${pdfPageSize.height}px` : 'min(70vh, 720px)',
                    }}
                  >
                    <CorrectionsPanel correctionList={correctionList} formatTs={formatTs} noOuterWrapper />
                  </aside>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom save / complete section (hidden when completed) */}
        {!isCompleted && (
          <div className="de-save-section">
            <div className="de-card">
              <p>Save your progress or mark the record as complete when all required fields are filled.</p>
              <div className="de-save-actions">
                <button className="btn btn-save" style={{ background: '#667eea', color: '#fff' }} disabled={saving} onClick={handleSave}>
                  {saving ? 'Saving...' : 'Save Data'}
                </button>
                {batchId && (
                  <button className="btn btn-complete" disabled={!canComplete} title={completeTitle} onClick={handleComplete}>
                    Mark as Complete
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {fieldInfoPanelField && (
        <FieldDetailPanel
          className="de-field-detail-panel--margin"
          style={fieldPanelAnchorStyle ?? undefined}
          field={fieldInfoPanelField}
          entry={formData[fieldInfoPanelField.id]}
          stageAccessible={fieldPanelStageAccessible}
          readOnly={isCompleted}
          onChange={handleFieldChange}
          onLockField={handleLockField}
          onStartCorrection={handleStartCorrection}
          onClose={() => setFieldInfoPanelId(null)}
          correctionRef={correctionRefMap[fieldInfoPanelField.id]}
          activeUsers={activeUsers}
          collaboratorSetupComplete={collaboratorSetupComplete}
          formatTs={formatTs}
          overlayScale={scale}
          editingCorrectionId={editingCorrectionId}
          correctionDraft={
            editingCorrectionId === fieldInfoPanelField.id ? correctionDraft : undefined
          }
          onCorrectionDraftChange={setCorrectionDraft}
          onSaveCorrection={handleSaveCorrectionRequest}
        />
      )}

      {recorderModalFieldId && collaboratorPolicy && (
        <div
          className="de-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recorder-modal-title"
        >
          <div
            className="de-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <h3 id="recorder-modal-title">Who is recording this entry?</h3>
            <p className="de-modal-desc">Select who is entering data for this field.</p>
            <div className="de-modal-actions col">
              <button
                type="button"
                className="de-modal-btn primary"
                onClick={() => confirmRecorderLock('primary')}
              >
                {collaboratorPolicy.primaryName} (Primary analyst)
              </button>
              <button
                type="button"
                className="de-modal-btn primary"
                onClick={() => confirmRecorderLock('secondary')}
              >
                {collaboratorPolicy.secondaryName} (Secondary reviewer)
              </button>
              <button
                type="button"
                className="de-modal-btn ghost"
                onClick={() => setRecorderModalFieldId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {correctionModal && (
        <div className="de-modal-overlay" role="dialog" aria-modal="true">
          <div className="de-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Who is making this edit?</h3>
            <p className="de-modal-desc">Document the person saving this correction.</p>
            {collaboratorPolicy ? (
              <div className="de-modal-editor-roles">
                <label className="de-modal-radio">
                  <input
                    type="radio"
                    name="de-editor"
                    checked={editorRole === 'primary'}
                    onChange={() => setEditorRole('primary')}
                  />
                  {collaboratorPolicy.primaryName} (Primary)
                </label>
                <label className="de-modal-radio">
                  <input
                    type="radio"
                    name="de-editor"
                    checked={editorRole === 'secondary'}
                    onChange={() => setEditorRole('secondary')}
                  />
                  {collaboratorPolicy.secondaryName} (Reviewer)
                </label>
                <label className="de-modal-radio">
                  <input
                    type="radio"
                    name="de-editor"
                    checked={editorRole === 'other'}
                    onChange={() => setEditorRole('other')}
                  />
                  Other
                </label>
                {editorRole === 'other' && (
                  <input
                    type="text"
                    className="de-modal-input"
                    placeholder="Name"
                    value={editorOther}
                    onChange={(e) => setEditorOther(e.target.value)}
                  />
                )}
              </div>
            ) : (
              <input
                type="text"
                className="de-modal-input"
                placeholder="Your name"
                value={editorOther}
                onChange={(e) => setEditorOther(e.target.value)}
              />
            )}
            <div className="de-modal-actions">
              <button type="button" className="de-modal-btn primary" onClick={confirmCorrectionSave}>
                Save correction
              </button>
              <button
                type="button"
                className="de-modal-btn ghost"
                onClick={() => {
                  setCorrectionModal(null)
                  setEditorOther('')
                  setEditingCorrectionId(null)
                  setCorrectionDraft(null)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {pdfPreviewOpen && (
        <div
          className="de-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pdf-preview-title"
          onClick={handleClosePdfPreview}
        >
          <div className="de-modal de-pdf-preview-modal" onClick={(e) => e.stopPropagation()}>
            <h3 id="pdf-preview-title">PDF export preview</h3>
            <p className="de-modal-desc">
              This matches the PDF you can download. It includes your current entries on this page (saved or not yet saved).
            </p>
            {pdfPreviewLoading && <p className="de-pdf-preview-status">Generating PDF…</p>}
            {pdfPreviewError && <p className="de-pdf-preview-error">{pdfPreviewError}</p>}
            {pdfPreviewUrl && !pdfPreviewLoading && (
              <iframe title="PDF preview" src={pdfPreviewUrl} className="de-pdf-preview-iframe" />
            )}
            <div className="de-modal-actions">
              <button type="button" className="de-modal-btn ghost" onClick={handleClosePdfPreview}>
                Close
              </button>
              <button
                type="button"
                className="de-modal-btn primary"
                disabled={!pdfPreviewUrl || pdfPreviewLoading}
                onClick={handleDownloadPdfFromPreview}
              >
                Download PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {completeModalOpen && collaboratorPolicy && (
        <div className="de-modal-overlay" role="dialog" aria-modal="true">
          <div className="de-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Secondary reviewer sign-off</h3>
            <p className="de-modal-desc">
              The secondary reviewer ({collaboratorPolicy.secondaryName}) signs off on this batch record.
            </p>
            <label className="de-modal-check">
              <input
                type="checkbox"
                checked={completeSignOffChecked}
                onChange={(e) => setCompleteSignOffChecked(e.target.checked)}
              />
              I confirm that <strong>{collaboratorPolicy.secondaryName}</strong> is signing off as secondary
              reviewer. This action cannot be undone.
            </label>
            <div className="de-modal-actions">
              <button
                type="button"
                className="de-modal-btn primary"
                disabled={!completeSignOffChecked}
                onClick={confirmSecondarySignOff}
              >
                Mark batch complete
              </button>
              <button
                type="button"
                className="de-modal-btn ghost"
                onClick={() => {
                  setCompleteModalOpen(false)
                  setCompleteSignOffChecked(false)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
