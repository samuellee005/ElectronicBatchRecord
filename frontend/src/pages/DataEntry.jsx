import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import PdfViewer from '../components/PdfViewer'
import { loadFormById, loadFormByPdf, saveData, createBatchRecord, updateBatchRecord } from '../api/client'
import './DataEntry.css'

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
  const { setEnteredAt, setLockedAt } = options
  const existing = isFieldEntryObject(entry) ? entry : null
  const now = new Date().toISOString()
  return {
    v: value,
    enteredAt: setEnteredAt ? (existing?.enteredAt ?? now) : existing?.enteredAt,
    lockedAt: setLockedAt ? (existing?.lockedAt ?? now) : existing?.lockedAt,
    corrections: existing?.corrections ?? [],
  }
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

function isFieldValueFilled(field, value) {
  if (field.type === 'checkbox') {
    return value === true || value === 'true' || value === 1
  }
  return value !== undefined && value !== null && value !== '' && (typeof value !== 'string' || value.trim() !== '')
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

// Build ref numbers for fields that have corrections (for side-panel reference)
function useCorrectionRefs(fields, formData) {
  return useMemo(() => {
    if (!fields?.length) return { refMap: {}, list: [] }
    const list = fields
      .map(f => ({ field: f, entry: formData[f.id] }))
      .filter(({ entry }) => isFieldEntryObject(entry) && Array.isArray(entry.corrections) && entry.corrections.length > 0)
    const refMap = {}
    list.forEach(({ field }, i) => { refMap[field.id] = i + 1 })
    return { refMap, list }
  }, [fields, formData])
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
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    if (value) {
      const img = new Image()
      img.onload = () => {
        try { ctx.drawImage(img, 0, 0, rect.width, rect.height) } catch {}
      }
      img.src = value
    }
    initialized.current = true
  }, []) // value captured once on mount

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
    if (ctx) { ctx.beginPath(); ctx.arc(c.x, c.y, 1, 0, Math.PI * 2); ctx.fill() }
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
    const r = canvas.parentElement.getBoundingClientRect()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, r.width, r.height)
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
function CorrectionsPanel({ correctionList, formatTs }) {
  if (!correctionList?.length) return null
  return (
    <div className="de-corrections-panel">
      <h3 className="de-corrections-panel-title">Corrections</h3>
      <p className="de-corrections-panel-hint">Reference numbers match the badges on the form.</p>
      <div className="de-corrections-list">
        {correctionList.map(({ field, entry }, idx) => {
          const refNum = idx + 1
          const corrections = entry.corrections || []
          const currentValue = getEffectiveValue(entry)
          const label = field.label || 'Field'
          return (
            <div key={field.id} className="de-correction-block" data-ref={refNum}>
              <div className="de-correction-block-header">
                <span className="de-correction-ref" aria-label={`Reference ${refNum}`}>{refNum}</span>
                <span className="de-correction-label">{label}</span>
                <span className="de-correction-current">Current: {String(currentValue ?? '—')}</span>
              </div>
              <ul className="de-correction-history">
                {corrections.map((c, i) => (
                  <li key={i}>
                    <span className="de-correction-old">{String(c.from)}</span>
                    <span className="de-correction-arrow" aria-hidden>→</span>
                    <span className="de-correction-new">{String(c.to)}</span>
                    <span className="de-correction-meta">({c.by}, {formatTs(c.at)})</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Scale at which the form was designed (FormBuilder default); overlay coords are in this space
const DESIGN_SCALE = 1.5

// ─── Field renderer (with audit: timestamp, lock after 1 min, corrections) ─────
function OverlayField({ field, entry, stageAccessible, onChange, editingCorrectionId, onStartCorrection, onSaveCorrection, onLockField, correctionRef, scale: currentScale = DESIGN_SCALE }) {
  const stageLocked = !stageAccessible
  const value = getEffectiveValue(entry)
  const fieldLocked = isFieldEntryLocked(entry)
  const isEditingCorrection = editingCorrectionId === field.id
  const req = isRequired(field)

  const scaleFactor = currentScale / DESIGN_SCALE
  const style = {
    left: field.x * scaleFactor,
    top: field.y * scaleFactor,
    width: field.width * scaleFactor,
    height: field.height * scaleFactor,
  }

  const enteredAt = isFieldEntryObject(entry) ? entry.enteredAt : null
  const corrections = isFieldEntryObject(entry) && Array.isArray(entry.corrections) ? entry.corrections : []

  const formatTs = (iso) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
    } catch {
      return iso
    }
  }

  // Locked and in correction mode: show crossed-out original + correction log + new input
  if (stageLocked) {
    return (
      <div className="overlay-field locked" style={style}>
        <div className="overlay-field-label">
          {field.label || 'Field'}
          {req && <span className="required-marker">*</span>}
        </div>
        <div className="overlay-field-audit">
          <span className="overlay-field-value-readonly">{value ?? '—'}</span>
          {enteredAt && <span className="overlay-field-timestamp">Entered {formatTs(enteredAt)}</span>}
        </div>
      </div>
    )
  }

  if (fieldLocked && isEditingCorrection) {
    return (
      <CorrectionEditor
        field={field}
        entry={entry}
        value={value}
        style={style}
        req={req}
        correctionRef={correctionRef}
        onSave={newVal => onSaveCorrection(field.id, newVal)}
        onCancel={() => onStartCorrection(null)}
        formatTs={formatTs}
      />
    )
  }

  if (fieldLocked && !isEditingCorrection) {
    return (
      <div className="overlay-field overlay-field-locked" style={style}>
        <div className="overlay-field-label">
          {field.label || 'Field'}
          {req && <span className="required-marker">*</span>}
          {correctionRef != null && (
            <span className="overlay-field-ref-badge" title={`See correction history #${correctionRef} in the panel`}>{correctionRef}</span>
          )}
        </div>
        <div className="overlay-field-audit">
          <span className="overlay-field-value-readonly">{value ?? '—'}</span>
          {enteredAt && <span className="overlay-field-timestamp">Entered {formatTs(enteredAt)}</span>}
          <button type="button" className="overlay-field-edit-btn" onClick={() => onStartCorrection(field.id)}>
            Edit
          </button>
        </div>
      </div>
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
        <textarea
          placeholder={field.placeholder || ''}
          value={value ?? ''}
          disabled={stageLocked}
          onChange={e => onChange(field.id, e.target.value)}
        />
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
    case 'checkbox':
      input = (
        <div className="overlay-checkbox-wrap">
          <input
            type="checkbox"
            checked={value === true || value === 'true' || value === 1}
            disabled={stageLocked}
            onChange={e => onChange(field.id, e.target.checked)}
          />
          <span>{field.label || 'Check'}</span>
        </div>
      )
      break
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

  const hasValue = isFieldValueFilled(field, value)
  const showSubmit = hasValue && !fieldLocked && !stageLocked

  return (
    <div className={`overlay-field${stageLocked ? ' locked' : ''}`} style={style}>
      <div className="overlay-field-label">
        {field.label || 'Field'}
        {req && <span className="required-marker">*</span>}
      </div>
      <div className="overlay-field-input-container">
        {input}
        {enteredAt && !fieldLocked && (
          <span className="overlay-field-timestamp overlay-field-timestamp-inline">Entered {formatTs(enteredAt)}</span>
        )}
        {showSubmit && onLockField && (
          <button type="button" className="overlay-field-submit-btn" onClick={() => onLockField(field.id)} title="Lock this field (data is correct)">
            Submit
          </button>
        )}
      </div>
    </div>
  )
}

// Inline correction editor: ref badge + crossed-out original + new input (past corrections in side panel)
function CorrectionEditor({ field, entry, value, style, req, correctionRef, onSave, onCancel, formatTs }) {
  const [newValue, setNewValue] = useState(value ?? '')
  const userName = (typeof localStorage !== 'undefined' && localStorage.getItem('ebrUserDisplayName')) || 'Unknown User'
  const displayValue = value ?? '—'

  return (
    <div className="overlay-field overlay-field-correction-editor" style={style}>
      <div className="overlay-field-label">
        {field.label || 'Field'}
        {req && <span className="required-marker">*</span>}
        {correctionRef != null && (
          <span className="overlay-field-ref-badge" title={`Correction history #${correctionRef} in panel`}>{correctionRef}</span>
        )}
      </div>
      <div className="overlay-field-audit">
        <div className="overlay-field-correction-new-entry overlay-field-correction-row">
          <span className="overlay-field-correction-original">{String(displayValue)}</span>
          <span className="overlay-field-correction-arrow" aria-hidden>→</span>
          <div className="overlay-field-correction-input-wrap">
          {field.type === 'textarea' ? (
            <textarea
              className="overlay-field-correction-input"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder="Enter corrected value"
              rows={2}
            />
          ) : field.type === 'number' ? (
            <div className="unit-input-group">
              <input
                type="number"
                className="overlay-field-correction-input"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                placeholder="Enter corrected value"
              />
              {field.unit && <div className="unit-display">{field.unit}</div>}
            </div>
          ) : field.type === 'date' ? (
            <input
              type="date"
              className="overlay-field-correction-input"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
            />
          ) : field.type === 'dropdown' ? (
            <select
              className="overlay-field-correction-input"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
            >
              <option value="">-- Select --</option>
              {(field.options || []).map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : field.type === 'checkbox' ? (
            <div className="overlay-checkbox-wrap">
              <input
                type="checkbox"
                checked={newValue === true || newValue === 'true' || newValue === 1}
                onChange={e => setNewValue(e.target.checked)}
              />
              <span>Corrected value</span>
            </div>
          ) : (
            <input
              type="text"
              className="overlay-field-correction-input"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder="Enter corrected value"
            />
          )}
            <div className="overlay-field-correction-actions">
              <button type="button" className="overlay-field-correction-save" onClick={() => onSave(newValue)}>Save correction</button>
              <button type="button" className="overlay-field-correction-cancel" onClick={onCancel}>Cancel</button>
            </div>
          </div>
            <span className="overlay-field-correction-meta overlay-field-correction-meta-inline">({userName}, date on save)</span>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function DataEntry() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const pdfRef = useRef(null)

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

  // Load form config
  useEffect(() => {
    if (!formId && !pdfParam) { setLoading(false); return }
    setLoading(true)
    setError(null)
    const p = formId ? loadFormById(formId) : loadFormByPdf(pdfParam)
    p.then(res => {
      if (!res.success || !res.form) throw new Error('Form configuration not found')
      setFormConfig(res.form)

      // Update last-seen version
      try {
        const key = `${res.form.name || ''}|${res.form.pdfFile || ''}`
        const ver = res.form.version || 1
        const stored = localStorage.getItem('ebrFormLastSeen')
        const lastSeen = stored ? JSON.parse(stored) : {}
        if (!lastSeen[key] || lastSeen[key] < ver) lastSeen[key] = ver
        localStorage.setItem('ebrFormLastSeen', JSON.stringify(lastSeen))
      } catch {}

      // Update recently used (for Commonly Used section)
      try {
        const raw = localStorage.getItem('ebrRecentlyUsed')
        const list = raw ? JSON.parse(raw) : []
        const entry = { formId: res.form.id, formName: res.form.name || 'Unnamed', openedAt: new Date().toISOString() }
        const merged = [entry, ...list.filter((x) => x.formId !== res.form.id)].slice(0, 30)
        localStorage.setItem('ebrRecentlyUsed', JSON.stringify(merged))
      } catch {}
    })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [formId, pdfParam])

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
    return formConfig.fields.filter(f => (f.page || 1) === currentPage)
  }, [formConfig, currentPage])

  const { refMap: correctionRefMap, list: correctionList } = useCorrectionRefs(formConfig?.fields, formData)

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

  // Field change handler: store as audit object with timestamp on first entry
  const handleFieldChange = useCallback((id, value) => {
    lastActivityRef.current[id] = Date.now()
    setFormData(prev => {
      const existing = prev[id]
      const normalized = normalizeEntry(existing, value, { setEnteredAt: true })
      return { ...prev, [id]: normalized }
    })
  }, [])

  const formDataRef = useRef(formData)
  formDataRef.current = formData

  // Idle lock: after 1 min without editing, lock the field
  useEffect(() => {
    if (!formConfig?.fields?.length) return
    const interval = setInterval(() => {
      const current = formDataRef.current
      const now = Date.now()
      let next = null
      formConfig.fields.forEach(f => {
        const id = f.id
        const entry = current[id]
        if (!entry) return
        const effective = getEffectiveValue(entry)
        if (effective === undefined || effective === null || effective === '') return
        if (isFieldEntryLocked(entry)) return
        const last = lastActivityRef.current[id] ?? 0
        if (now - last >= IDLE_LOCK_MS) {
          if (!next) next = { ...current }
          next[id] = normalizeEntry(entry, effective, { setEnteredAt: false, setLockedAt: true })
        }
      })
      if (next) setFormData(next)
    }, 10000)
    return () => clearInterval(interval)
  }, [formConfig?.fields])

  const handleSaveCorrection = useCallback((fieldId, newValue) => {
    const userName = (typeof localStorage !== 'undefined' && localStorage.getItem('ebrUserDisplayName')) || 'Unknown User'
    const correctedAt = new Date().toISOString()
    setFormData(prev => ({
      ...prev,
      [fieldId]: addCorrection(prev[fieldId], newValue, userName, correctedAt),
    }))
    setEditingCorrectionId(null)
  }, [])

  // Lock field on demand when user clicks Submit (confirm data is correct)
  const handleLockField = useCallback((fieldId) => {
    setFormData(prev => {
      const entry = prev[fieldId]
      const effective = getEffectiveValue(entry)
      if (effective === undefined || effective === null || effective === '') return prev
      if (isFieldEntryLocked(entry)) return prev
      return {
        ...prev,
        [fieldId]: normalizeEntry(entry, effective, { setEnteredAt: false, setLockedAt: true }),
      }
    })
  }, [])

  const onPageRendered = useCallback(({ page, totalPages: n }) => {
    setCurrentPage(page)
    if (n != null) setTotalPages(n)
  }, [])

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 3))
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5))
  const resetZoom = () => setScale(1.5)

  // Save handler
  const handleSave = useCallback(async () => {
    if (!formConfig) return
    const errors = []
    formConfig.fields.forEach(f => {
      if (isRequired(f) && !isFieldValueFilled(f, formDataEffective[f.id])) {
        errors.push(f.label || f.id)
      }
    })
    if (errors.length) {
      alert('Please fill in all required fields:\n- ' + errors.join('\n- '))
      return
    }
    setSaving(true)
    try {
      const body = {
        formId: formConfig.id,
        formName: formConfig.name,
        pdfFile: formConfig.pdfFile,
        data: formData,
        stageCompletion,
        stages: stages.map(s => ({ stage: s.stage, order: s.order })),
        savedAt: new Date().toISOString(),
      }
      if (batchId) body.batchId = batchId
      const res = await saveData(body)
      if (res.success) alert('Data saved successfully!')
      else alert('Error saving data: ' + (res.message || 'Unknown error'))
    } catch (err) {
      alert('Error saving data: ' + err.message)
    } finally {
      setSaving(false)
    }
  }, [formConfig, formData, formDataEffective, stageCompletion, stages, batchId])

  // Mark complete
  const handleComplete = useCallback(async () => {
    if (!batchId) return
    if (!window.confirm('Mark this batch record as complete? This cannot be undone.')) return
    try {
      const res = await updateBatchRecord({ batchId, status: 'completed' })
      if (res.success) {
        navigate('/batch?filter=completed')
      } else {
        alert('Error: ' + (res.message || 'Unknown error'))
      }
    } catch (err) {
      alert('Error completing batch: ' + err.message)
    }
  }, [batchId, navigate])

  // Create batch
  const handleCreateBatch = useCallback(async () => {
    if (!batchTitle.trim()) { alert('Title is required'); return }
    setCreatingBatch(true)
    try {
      const res = await createBatchRecord({
        formId: formConfig.id,
        formName: formConfig.name,
        title: batchTitle.trim(),
        description: batchDesc.trim(),
        createdBy: localStorage.getItem('ebrUserDisplayName') || '',
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
  }, [batchTitle, batchDesc, formConfig, searchParams, navigate])

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
          <button className="btn btn-save" disabled={saving} onClick={handleSave}>
            {saving ? 'Saving...' : 'Save Data'}
          </button>
          {batchId && (
            <button className="btn btn-complete" disabled={!canComplete} title={completeTitle} onClick={handleComplete}>
              Mark as Complete
            </button>
          )}
        </div>
      </div>

      <div className="de-layout de-layout-single">
        {/* Form info + Stages: 50/50 on one row when stages exist */}
        <div className={stages.length > 0 ? 'de-form-and-stages-row' : ''}>
          <div className="de-card de-form-info">
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
          {stages.length > 0 && (
            <div className="de-card stages-panel">
              <h3>Stages</h3>
              {stages.map(stage => {
                const completed = stageCompletion[stage.stage]
                const accessible = isStageAccessible(stage, stages, stageCompletion)
                const isCurrent = accessible && !completed
                let cls = ''
                if (completed) cls = 'completed'
                else if (isCurrent) cls = 'current'
                else if (!accessible) cls = 'locked'

                return (
                  <div key={stage.stage} className={`stage-item ${cls}`}>
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

        {/* PDF area + corrections panel (off-page, right): ref numbers link field to panel */}
        <div className="de-pdf-and-corrections">
          <div className="de-pdf-area">
          <div className="de-pdf-toolbar">
            <div className="de-pdf-toolbar-spacer" aria-hidden="true" />
            <div className="de-pdf-toolbar-center">
              {totalPages > 1 && (
                <div className="de-pdf-pagination">
                  <button type="button" disabled={currentPage <= 1} onClick={() => pdfRef.current?.changePage(-1)}>Previous</button>
                  <span>Page {currentPage} of {totalPages}</span>
                  <button type="button" disabled={currentPage >= totalPages} onClick={() => pdfRef.current?.changePage(1)}>Next</button>
                </div>
              )}
            </div>
            <div className="de-pdf-toolbar-right">
              <div className="de-zoom-controls">
              <button type="button" onClick={zoomOut} title="Zoom out">&minus;</button>
              <span>{Math.round(scale * 100)}%</span>
              <button type="button" onClick={zoomIn} title="Zoom in">+</button>
              <button type="button" onClick={resetZoom} title="Reset zoom">Reset</button>
              </div>
            </div>
          </div>
          <PdfViewer
            ref={pdfRef}
            pdfUrl={`/uploads/${formConfig.pdfFile}`}
            scale={scale}
            onPageRendered={onPageRendered}
            paginationPosition="bottom"
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
                    editingCorrectionId={editingCorrectionId}
                    onStartCorrection={setEditingCorrectionId}
                    onSaveCorrection={handleSaveCorrection}
                    onLockField={handleLockField}
                  />
                )
              })}
          </PdfViewer>
          </div>
          <CorrectionsPanel correctionList={correctionList} formatTs={formatTs} />
        </div>

        {/* Bottom save / complete section */}
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
      </div>
    </div>
  )
}
