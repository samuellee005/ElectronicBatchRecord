import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import PdfViewer from '../components/PdfViewer'
import {
  loadFormById,
  loadFormByPdf,
  saveData,
  createBatchRecord,
  updateBatchRecord,
  getBatchRecord,
  getDownloadBatchPdfUrl,
  listActiveUsers,
} from '../api/client'
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
  if (value === undefined || value === null || value === '') return '—'
  if (field.type === 'checkbox') {
    return value === true || value === 'true' || value === 1 ? 'Yes' : 'No'
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
function CorrectionsPanel({ correctionList, formatTs, noOuterWrapper }) {
  if (!correctionList?.length) return null
  const inner = (
    <>
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
                <span className="de-correction-current">Current: {displayFieldValue(field, currentValue)}</span>
              </div>
              <ul className="de-correction-history">
                {corrections.map((c, i) => (
                  <li key={i}>
                    <span className="de-correction-old">{displayFieldValue(field, c.from)}</span>
                    <span className="de-correction-arrow" aria-hidden>→</span>
                    <span className="de-correction-new">{displayFieldValue(field, c.to)}</span>
                    <span className="de-correction-meta">({c.by}, {formatTs(c.at)})</span>
                  </li>
                ))}
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
              <span className="overlay-audit-info-val">#{correctionRef} (see Corrections panel)</span>
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

// ─── Field renderer (with audit: timestamp, lock after 1 min, corrections) ─────
function OverlayField({
  field,
  entry,
  stageAccessible,
  onChange,
  editingCorrectionId,
  onStartCorrection,
  onSaveCorrection,
  onLockField,
  correctionRef,
  scale: currentScale = DESIGN_SCALE,
  readOnly = false,
  activeUsers = [],
  collaboratorSetupComplete = true,
}) {
  const stageLocked = !stageAccessible || readOnly
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
        <div className="overlay-field-label overlay-field-label-row">
          <span className="overlay-field-label-text">
            {field.label || 'Field'}
            {req && <span className="required-marker">*</span>}
          </span>
          <FieldAuditInfoPopover entry={entry} formatTs={formatTs} correctionRef={correctionRef} />
        </div>
        <div className="overlay-field-audit">
          <span className="overlay-field-value-readonly">{displayFieldValue(field, value)}</span>
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
        onSave={(newVal) => onSaveCorrection(field.id, newVal)}
        activeUsers={activeUsers}
        onCancel={() => onStartCorrection(null)}
        formatTs={formatTs}
      />
    )
  }

  if (fieldLocked && !isEditingCorrection) {
    return (
      <div className="overlay-field overlay-field-locked" style={style}>
        <div className="overlay-field-locked-header">
          <div className="overlay-field-locked-title">
            {field.label || 'Field'}
            {req && <span className="required-marker">*</span>}
            {correctionRef != null && (
              <span className="overlay-field-ref-badge" title={`See correction history #${correctionRef} in the panel`}>{correctionRef}</span>
            )}
          </div>
          <div className="overlay-field-locked-header-actions">
            <FieldAuditInfoPopover entry={entry} formatTs={formatTs} correctionRef={correctionRef} />
            <button type="button" className="overlay-field-edit-btn overlay-field-edit-btn-header" onClick={() => onStartCorrection(field.id)}>
              Edit
            </button>
          </div>
        </div>
        <div className="overlay-field-audit">
          <span className="overlay-field-value-readonly">{displayFieldValue(field, value)}</span>
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
        <div className="overlay-collaborator">
          {field.helpText && <p className="overlay-collab-help">{field.helpText}</p>}
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
  const blockedByCollaborator =
    field.type !== 'collaborator' && !collaboratorSetupComplete
  const showSubmit =
    hasValue && !fieldLocked && !stageLocked && !blockedByCollaborator

  return (
    <div className={`overlay-field${stageLocked ? ' locked' : ''}`} style={style}>
      <div className="overlay-field-label overlay-field-label-row">
        <span className="overlay-field-label-text">
          {field.label || 'Field'}
          {req && <span className="required-marker">*</span>}
        </span>
        {!fieldLocked && (
          <FieldAuditInfoPopover entry={entry} formatTs={formatTs} correctionRef={correctionRef} />
        )}
      </div>
      <div className="overlay-field-input-container">
        {blockedByCollaborator && (
          <p className="overlay-collab-block-hint">Complete the Collaborator Entry field first.</p>
        )}
        {input}
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
function CorrectionEditor({
  field,
  entry,
  value,
  style,
  req,
  correctionRef,
  onSave,
  onCancel,
  formatTs,
  activeUsers = [],
}) {
  const [newValue, setNewValue] = useState(() => {
    if (field.type === 'multiselect') return parseMultiselectValue(value)
    if (field.type === 'checkbox') return value === true || value === 'true' || value === 1
    if (field.type === 'collaborator') return collaboratorDraft(value)
    return value ?? ''
  })
  useEffect(() => {
    if (field.type === 'multiselect') setNewValue(parseMultiselectValue(value))
    else if (field.type === 'checkbox') setNewValue(value === true || value === 'true' || value === 1)
    else if (field.type === 'collaborator') setNewValue(collaboratorDraft(value))
    else setNewValue(value ?? '')
  }, [field.id, field.type, value])

  const displayValue = displayFieldValue(field, value)
  const handleSave = () => {
    if (field.type === 'multiselect') onSave([...newValue])
    else if (field.type === 'collaborator') {
      const cv = collaboratorDraft(newValue)
      const map = Object.fromEntries(activeUsers.map((u) => [u.id, u.displayName]))
      onSave({
        ...cv,
        primaryDisplayName: map[cv.primaryUserId] || cv.primaryUserId,
        secondaryDisplayName: map[cv.secondaryUserId] || cv.secondaryUserId,
      })
    } else onSave(newValue)
  }

  let correctionInput
  if (field.type === 'textarea') {
    correctionInput = (
      <textarea
        className="overlay-field-correction-input"
        value={newValue}
        onChange={e => setNewValue(e.target.value)}
        placeholder="Enter corrected value"
        rows={2}
      />
    )
  } else if (field.type === 'number') {
    correctionInput = (
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
    )
  } else if (field.type === 'date') {
    correctionInput = (
      <input
        type="date"
        className="overlay-field-correction-input"
        value={newValue}
        onChange={e => setNewValue(e.target.value)}
      />
    )
  } else if (field.type === 'time') {
    correctionInput = (
      <div className="overlay-time-row">
        <input
          type="time"
          className="overlay-field-correction-input"
          value={typeof newValue === 'string' ? newValue.slice(0, 5) : ''}
          onChange={e => setNewValue(e.target.value)}
        />
        <button
          type="button"
          className="overlay-time-now-btn"
          onClick={() => {
            const d = new Date()
            setNewValue(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
          }}
        >
          Now
        </button>
      </div>
    )
  } else if (field.type === 'dropdown') {
    correctionInput = (
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
    )
  } else if (field.type === 'radio') {
    correctionInput = (
      <div className="overlay-radio-group">
        {(field.options || []).map(opt => (
          <label key={opt} className="overlay-radio-label">
            <input
              type="radio"
              name={`de-rc-${field.id}`}
              value={opt}
              checked={newValue === opt}
              onChange={() => setNewValue(opt)}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    )
  } else if (field.type === 'multiselect') {
    const sel = Array.isArray(newValue) ? newValue : []
    correctionInput = (
      <div className="overlay-multiselect-group">
        {(field.options || []).map(opt => (
          <label key={opt} className="overlay-radio-label">
            <input
              type="checkbox"
              checked={sel.includes(opt)}
              onChange={() => {
                setNewValue(sel.includes(opt) ? sel.filter(x => x !== opt) : [...sel, opt])
              }}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    )
  } else if (field.type === 'checkbox') {
    correctionInput = (
      <div className="overlay-checkbox-wrap">
        <input
          type="checkbox"
          checked={newValue === true || newValue === 'true' || newValue === 1}
          onChange={e => setNewValue(e.target.checked)}
        />
        <span>Corrected value</span>
      </div>
    )
  } else if (field.type === 'collaborator') {
    const cv = collaboratorDraft(newValue)
    const opts = activeUsers.filter((u) => u.active !== false)
    correctionInput = (
      <div className="overlay-collaborator overlay-collab-correction">
        <label className="overlay-collab-label">
          Primary analyst
          <select
            value={cv.primaryUserId}
            onChange={(e) => setNewValue({ ...cv, primaryUserId: e.target.value })}
          >
            <option value="">—</option>
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
            onChange={(e) => setNewValue({ ...cv, secondaryUserId: e.target.value })}
          >
            <option value="">—</option>
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
              setNewValue({ ...cv, reviewerIsDesignatedRecorder: e.target.checked })
            }
          />
          Reviewer records all entry
        </label>
      </div>
    )
  } else {
    correctionInput = (
      <input
        type="text"
        className="overlay-field-correction-input"
        value={newValue}
        onChange={e => setNewValue(e.target.value)}
        placeholder="Enter corrected value"
      />
    )
  }

  return (
    <div className="overlay-field overlay-field-correction-editor" style={style}>
      <div className="overlay-field-label overlay-field-label-row">
        <span className="overlay-field-label-text">
          {field.label || 'Field'}
          {req && <span className="required-marker">*</span>}
          {correctionRef != null && (
            <span className="overlay-field-ref-badge" title={`Correction history #${correctionRef} in panel`}>{correctionRef}</span>
          )}
        </span>
        <FieldAuditInfoPopover entry={entry} formatTs={formatTs} correctionRef={correctionRef} />
      </div>
      <div className="overlay-field-audit">
        <div className="overlay-field-correction-new-entry overlay-field-correction-row">
          <span className="overlay-field-correction-original">{displayValue}</span>
          <span className="overlay-field-correction-arrow" aria-hidden>→</span>
          <div className="overlay-field-correction-input-wrap">
            {correctionInput}
            <div className="overlay-field-correction-actions">
              <button type="button" className="overlay-field-correction-save" onClick={handleSave}>Save correction</button>
              <button type="button" className="overlay-field-correction-cancel" onClick={onCancel}>Cancel</button>
            </div>
          </div>
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

  // Batch record when viewing by batchId (status, prefill formData, completed = read-only)
  const [batchRecord, setBatchRecord] = useState(null)
  const [isCompleted, setIsCompleted] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)

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
        const entry = { formId: res.form.id, formName: res.form.name || 'Unnamed', pdfFile: res.form.pdfFile || '', openedAt: new Date().toISOString() }
        const merged = [entry, ...list.filter((x) => x.formId !== res.form.id)].slice(0, 30)
        localStorage.setItem('ebrRecentlyUsed', JSON.stringify(merged))
      } catch {}
    })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [formId, pdfParam])

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
      .catch(() => {})
      .finally(() => setBatchLoading(false))
  }, [batchId, formConfig?.id])

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
  const [activeUsers, setActiveUsers] = useState([])
  const [recorderModalFieldId, setRecorderModalFieldId] = useState(null)
  const [correctionModal, setCorrectionModal] = useState(null)
  const [editorRole, setEditorRole] = useState('primary')
  const [editorOther, setEditorOther] = useState('')
  const [completeModalOpen, setCompleteModalOpen] = useState(false)
  const [completeSignOffChecked, setCompleteSignOffChecked] = useState(false)

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
      .catch(() => {})
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
    setEditorOther(
      pol
        ? ''
        : (typeof localStorage !== 'undefined' && localStorage.getItem('ebrUserDisplayName')) || '',
    )
    setCorrectionModal({ fieldId, newValue })
  }, [])

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
      by =
        editorOther.trim() ||
        (typeof localStorage !== 'undefined' && localStorage.getItem('ebrUserDisplayName')) ||
        ''
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
    setCorrectionModal(null)
    setEditorOther('')
  }, [correctionModal, editorRole, editorOther])

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

  function fIsEmptyEffective(field, effective) {
    if (field?.type === 'multiselect') return parseMultiselectValue(effective).length === 0
    if (field?.type === 'checkbox')
      return effective !== true && effective !== 'true' && effective !== 1
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
  const onPageRendered = useCallback(({ page, totalPages: n, width, height }) => {
    setCurrentPage(page)
    if (n != null) setTotalPages(n)
    if (width > 0 && height > 0) setPdfPageSize({ width, height })
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

  // Download completed batch as PDF
  const handleDownloadPdf = useCallback(() => {
    if (!batchId) return
    const url = getDownloadBatchPdfUrl(batchId)
    fetch(url)
      .then((res) => {
        const ct = res.headers.get('Content-Type') || ''
        if (ct.includes('application/json')) {
          return res.json().then((data) => {
            if (!data.success) throw new Error(data.message || 'Download failed')
          })
        }
        if (!res.ok) throw new Error('Download failed')
        return res.blob()
      })
      .then((blob) => {
        if (blob instanceof Blob) {
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = (batchRecord?.title || 'batch') + '_' + new Date().toISOString().slice(0, 10) + '.pdf'
          a.click()
          URL.revokeObjectURL(a.href)
        }
      })
      .catch((err) => alert(err.message || 'Could not download PDF'))
  }, [batchId, batchRecord?.title])

  const runCompleteBatch = useCallback(
    async (extra = {}) => {
      if (!batchId) return
      try {
        const res = await updateBatchRecord({ batchId, status: 'completed', ...extra })
        if (res.success) {
          navigate('/batch?filter=completed')
        } else {
          alert('Error: ' + (res.message || 'Unknown error'))
        }
      } catch (err) {
        alert('Error completing batch: ' + err.message)
      }
    },
    [batchId, navigate],
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
          {isCompleted ? (
            <button type="button" className="btn btn-download-pdf" onClick={handleDownloadPdf}>
              Download PDF
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
            </>
          )}
        </div>
      </div>

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

        {/* PDF + corrections flush right of page; panel height tracks rendered page (zoom/page change) */}
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
            <div className="de-pdf-viewport">
              <div className="de-pdf-page-and-corrections">
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
                        onSaveCorrection={handleSaveCorrectionRequest}
                        onLockField={handleLockField}
                        readOnly={isCompleted}
                        activeUsers={activeUsers}
                        collaboratorSetupComplete={collaboratorSetupComplete}
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
                }}
              >
                Cancel
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
