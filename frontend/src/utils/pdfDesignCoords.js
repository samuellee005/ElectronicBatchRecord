/**
 * Convert PDF point-space rectangles (PyMuPDF / pdf.js user units, y downward)
 * to Form Builder "design" pixel coordinates at scale 1.5 (matches FormBuilder DESIGN_SCALE).
 */
import { pdfjs } from 'react-pdf'
import { FORM_FIELD_DEFAULTS, DEFAULT_INPUT_FONT_PX } from './formFieldDefaults'

const DESIGN_SCALE = 1.5

if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
}

function rectPtsToDesignForPage(page, rectPts) {
  const vp = page.getViewport({ scale: DESIGN_SCALE })
  // The detector emits top-left-origin PDF points (PyMuPDF / pdfplumber
  // / Adobe convention). pdf.js's convertToViewportPoint expects user
  // space coords with bottom-left origin, so we pre-flip Y before the
  // transform.
  const pageH = page.view[3] - page.view[1]
  const tl = vp.convertToViewportPoint(rectPts.x, pageH - rectPts.y)
  const br = vp.convertToViewportPoint(
    rectPts.x + rectPts.width,
    pageH - (rectPts.y + rectPts.height),
  )
  const x = Math.min(tl[0], br[0])
  const y = Math.min(tl[1], br[1])
  const width = Math.max(2, Math.abs(br[0] - tl[0]))
  const height = Math.max(2, Math.abs(br[1] - tl[1]))
  return { x, y, width, height }
}

/**
 * @param {ArrayBuffer} pdfBytes
 * @param {Array<{ id: string, page: number, fieldType: string, x: number, y: number, width: number, height: number, labelText?: string, kind?: string, confidence?: number }>} suggestions
 * @returns {Promise<object[]>} FormBuilder-ready field objects (same shape as FormBuilder addField)
 */
export async function suggestionsToFormFields(pdfBytes, suggestions) {
  const pdf = await pdfjs.getDocument({ data: pdfBytes }).promise
  const out = []
  let order = 0
  for (const s of suggestions) {
    const type = FORM_FIELD_DEFAULTS[s.fieldType] ? s.fieldType : 'text'
    const page = await pdf.getPage(s.page)
    let { x, y, width, height } = rectPtsToDesignForPage(page, {
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
    })
    // For from-cell suggestions, trust the detected geometry — the cell
    // rect was sized to fit the underlying input area. Clamps would push
    // narrow cell inputs off their underlines.
    if (s.fromCell) {
      width = Math.max(8, width)
      height = Math.max(8, height)
    } else if (type === 'checkbox') {
      width = Math.min(Math.max(width, 18), 56)
      height = Math.min(Math.max(height, 18), 56)
    } else if (type === 'signature') {
      width = Math.max(width, 200)
      height = Math.max(height, 64)
    } else {
      width = Math.max(width, 72)
      height = Math.max(height, 24)
    }
    order += 1
    out.push(
      buildFieldFromSuggestion(
        {
          ...s,
          fieldType: type,
        },
        {
          page: s.page,
          x,
          y,
          width,
          height,
        },
        order,
      ),
    )
  }
  return out
}

export function buildFieldFromSuggestion(suggestion, rect, orderInGroup = 1) {
  const type = FORM_FIELD_DEFAULTS[suggestion.fieldType] ? suggestion.fieldType : 'text'
  const defs = FORM_FIELD_DEFAULTS[type]
  const label = (suggestion.labelText && String(suggestion.labelText).trim()) || defs.label
  const id =
    suggestion.id && String(suggestion.id).trim()
      ? `field_${String(suggestion.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : `field_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const field = {
    id,
    type,
    page: rect.page,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    label,
    required: false,
    stageInProcess: '',
    stageOrder: null,
    placeholder: defs.placeholder || '',
    unit: defs.unit ?? '',
    inputFontSize: defs.inputFontSize ?? DEFAULT_INPUT_FONT_PX,
    orderInGroup,
  }
  if (defs.options) {
    field.options = [...defs.options]
  }
  if (defs.helpText) {
    field.helpText = defs.helpText
  }
  if (type === 'checkbox') {
    field.placeholder = ''
  }
  if (suggestion.tableId !== undefined && suggestion.tableId !== null) {
    field.detection = {
      tableId: suggestion.tableId,
      cellRow: suggestion.cellRow,
      cellCol: suggestion.cellCol,
      kind: suggestion.kind,
      fromCell: !!suggestion.fromCell,
    }
  }
  return field
}

export const EBR_PENDING_SUGGESTIONS_KEY = 'ebrPendingSuggestions'
