import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  PencilSquareIcon,
  CalendarIcon,
  HashtagIcon,
  ChevronUpDownIcon,
  CheckIcon,
  ClockIcon,
  StopCircleIcon,
  Squares2X2Icon,
  UserGroupIcon,
  TableCellsIcon,
  Bars3Icon,
} from '@heroicons/react/24/outline'
import PdfViewer from '../components/PdfViewer'
import PdfPageScrubber from '../components/PdfPageScrubber'
import PdfZoomControls from '../components/PdfZoomControls'
import FieldPreview from '../components/forms/FieldPreview'
import { listForms, loadFormById, saveForm } from '../api/client'
import { useUserPrefs } from '../context/UserPrefsContext'
import { buildTableMergeLayout, tableCellKey } from '../utils/tableMergeLayout'
import { DEFAULT_TABLE_COL_WIDTH, DEFAULT_TABLE_ROW_HEIGHT, tableColWidthPx, tableRowHeightPx } from '../utils/tableFieldDims'
import { FORM_FIELD_DEFAULTS, DEFAULT_INPUT_FONT_PX } from '../utils/formFieldDefaults'
import { EBR_PENDING_SUGGESTIONS_KEY } from '../utils/pdfDesignCoords'
import './FormBuilder.css'

const COMPONENT_TYPES = [
  { type: 'text', Icon: PencilSquareIcon, name: 'Text' },
  { type: 'date', Icon: CalendarIcon, name: 'Date' },
  { type: 'number', Icon: HashtagIcon, name: 'Number' },
  { type: 'dropdown', Icon: ChevronUpDownIcon, name: 'Dropdown' },
  { type: 'checkbox', Icon: CheckIcon, name: 'Checkbox' },
  { type: 'time', Icon: ClockIcon, name: 'Time' },
  { type: 'radio', Icon: StopCircleIcon, name: 'Radio Group' },
  { type: 'multiselect', Icon: Squares2X2Icon, name: 'Multi Select' },
  { type: 'collaborator', Icon: UserGroupIcon, name: 'Collaborator' },
  { type: 'table', Icon: TableCellsIcon, name: 'Data Table' },
]

const DEFAULT_CONFIGS = { ...FORM_FIELD_DEFAULTS }

const UNIT_OPTIONS = ['', 'kg', 'g', 'mg', 'L', 'mL', '\u00B0C', '\u00B0F', '%', 'ppm', 'pH']

const SNAP_THRESHOLD = 5
const RULER_TICK_INTERVAL = 50
const RULER_LABEL_INTERVAL = 100
const RULER_SIZE = 24
// Scale at which field coordinates are stored; overlay positions scale with zoom
const DESIGN_SCALE = 1.5

const PROPERTIES_PANEL_DEFAULT_W = 320
const PROPERTIES_PANEL_MIN_W = 260
const PROPERTIES_PANEL_MAX_W = 640
const PROPERTIES_PANEL_WIDTH_STORAGE_KEY = 'fb-properties-panel-width'

function newTablePartId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

/** Unique stage names in process order (by stageOrder across fields in that stage). */
function buildOrderedStageNames(fields) {
  const seen = new Map()
  for (const f of fields || []) {
    const n = f.stageInProcess?.trim()
    if (!n) continue
    const o = Number(f.stageOrder)
    const ord = Number.isFinite(o) && o > 0 ? o : 9999
    if (!seen.has(n) || seen.get(n) > ord) seen.set(n, ord)
  }
  return [...seen.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
}

function reorderStringArray(arr, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return [...arr]
  if (fromIndex >= arr.length || toIndex >= arr.length) return [...arr]
  const a = [...arr]
  const [it] = a.splice(fromIndex, 1)
  a.splice(toIndex, 0, it)
  return a
}

function applyStageNameOrderToFields(orderedNames) {
  const m = new Map(orderedNames.map((n, i) => [n, i + 1]))
  return (prev) =>
    prev.map((f) => {
      const n = f.stageInProcess?.trim()
      if (!n) return f
      const o = m.get(n)
      if (o == null) return f
      return f.stageOrder === o ? f : { ...f, stageOrder: o }
    })
}

function getComponentTypeLabel(type) {
  const c = COMPONENT_TYPES.find((x) => x.type === type)
  return c ? c.name : (type || 'Field')
}

/** Unassigned and each stage are separate groups: order 1..n in the Stages list + properties. */
function stageKey(f) {
  return (f?.stageInProcess && String(f.stageInProcess).trim()) || ''
}

function maxStageOrderInForm(fields) {
  let max = 0
  for (const f of fields || []) {
    const n = Number(f?.stageOrder)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

function nextUnusedStageOrder(fields) {
  return maxStageOrderInForm(fields) + 1
}

function sortFieldsInGroupList(fields, key) {
  return fields
    .filter((f) => stageKey(f) === key)
    .sort((a, b) => {
      const oa = Number(a.orderInGroup)
      const ob = Number(b.orderInGroup)
      const aOk = Number.isFinite(oa) && oa > 0
      const bOk = Number.isFinite(ob) && ob > 0
      if (aOk && bOk && oa !== ob) return oa - ob
      if (aOk && !bOk) return -1
      if (!aOk && bOk) return 1
      return a.id.localeCompare(b.id)
    })
}

function sortFieldIdsInGroup(fields, key) {
  return sortFieldsInGroupList(fields, key).map((f) => f.id)
}

/**
 * Apply new `orderInGroup` for a moved/reordered field and renumber affected groups.
 * `oldKey` is the field's group before the move (required when that differs from key in `prev` for the field,
 * e.g. after a partial merge). `patch` merges onto the moved field (e.g. `stageOrder` from the properties form).
 */
function applyFieldGroupPlacement(prev, fieldId, newKey, orderedIds, oldKey, patch) {
  const nk = (newKey || '').trim()
  const newOrderMap = new Map(orderedIds.map((id, i) => [id, i + 1]))
  let oldOrderMap = null
  if (oldKey !== nk) {
    const oldIds = sortFieldIdsInGroup(prev, oldKey).filter((id) => id !== fieldId)
    oldOrderMap = new Map(oldIds.map((id, i) => [id, i + 1]))
  }
  return prev.map((f) => {
    if (f.id === fieldId) {
      const og = newOrderMap.get(f.id)
      if (og == null) return f
      if (oldKey === nk) {
        const n = f.orderInGroup === og ? f : { ...f, orderInGroup: og }
        return patch && Object.keys(patch).length ? { ...n, ...patch } : n
      }
      if (!nk) {
        const o = { ...f, orderInGroup: og, stageInProcess: '', stageOrder: null }
        return patch && Object.keys(patch).length ? { ...o, ...patch } : o
      }
      const peer = prev.find(
        (x) => x.id !== fieldId && String(x.stageInProcess || '').trim() === nk,
      )
      const so =
        patch && patch.stageOrder != null
          ? Number(patch.stageOrder)
          : peer != null && Number.isFinite(Number(peer.stageOrder))
            ? Number(peer.stageOrder)
            : nextUnusedStageOrder(prev.filter((x) => x.id !== fieldId))
      const o = { ...f, orderInGroup: og, stageInProcess: nk, stageOrder: so }
      if (patch && Object.keys(patch).length) {
        const p = { ...o, ...patch, orderInGroup: og, stageInProcess: nk }
        if (patch.stageOrder != null) p.stageOrder = patch.stageOrder
        return p
      }
      return o
    }
    if (oldKey !== nk) {
      const sk = stageKey(f)
      if (sk === oldKey && oldOrderMap && oldOrderMap.has(f.id)) {
        const o = oldOrderMap.get(f.id)
        return f.orderInGroup === o ? f : { ...f, orderInGroup: o }
      }
      if (sk === nk && newOrderMap.has(f.id)) {
        const o = newOrderMap.get(f.id)
        return f.orderInGroup === o ? f : { ...f, orderInGroup: o }
      }
    } else if (newOrderMap.has(f.id)) {
      const o = newOrderMap.get(f.id)
      return f.orderInGroup === o ? f : { ...f, orderInGroup: o }
    }
    return f
  })
}

/**
 * @param {object | null} patch - merged onto the moved field (e.g. from properties when `stageInProcess` changes)
 * @param {string | null} oldKeyOverride - if set, use as previous group (when `prev` was already updated)
 */
function placeFieldInGroupOrder(
  prev,
  fieldId,
  newKey,
  anchorFieldId,
  insertBefore,
  oldKeyOverride = null,
  patch = null,
) {
  const nk = (newKey || '').trim()
  const f0 = prev.find((f) => f.id === fieldId)
  if (!f0) return prev
  const oldKey = oldKeyOverride != null && oldKeyOverride !== undefined ? String(oldKeyOverride) : stageKey(f0)
  let newGroupIds = sortFieldIdsInGroup(prev, nk).filter((id) => id !== fieldId)
  let insertAt = newGroupIds.length
  if (anchorFieldId && newGroupIds.includes(anchorFieldId)) {
    const ai = newGroupIds.indexOf(anchorFieldId)
    insertAt = insertBefore ? ai : ai + 1
  }
  newGroupIds = [...newGroupIds.slice(0, insertAt), fieldId, ...newGroupIds.slice(insertAt)]
  return applyFieldGroupPlacement(prev, fieldId, nk, newGroupIds, oldKey, patch)
}

function normalizeFieldGroupOrder(fields) {
  if (!fields?.length) return fields
  const byKey = new Map()
  for (const f of fields) {
    const k = stageKey(f)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(f)
  }
  const idToOrder = new Map()
  for (const arr of byKey.values()) {
    arr.sort((a, b) => {
      const oa = Number(a.orderInGroup)
      const ob = Number(b.orderInGroup)
      const aOk = Number.isFinite(oa) && oa > 0
      const bOk = Number.isFinite(ob) && ob > 0
      if (aOk && bOk && oa !== ob) return oa - ob
      if (aOk && !bOk) return -1
      if (!aOk && bOk) return 1
      return a.id.localeCompare(b.id)
    })
    arr.forEach((x, i) => idToOrder.set(x.id, i + 1))
  }
  return fields.map((f) => {
    const o = idToOrder.get(f.id)
    if (f.orderInGroup === o) return f
    return { ...f, orderInGroup: o }
  })
}

/** Split total between two sizes by delta; enforce minimum. */
function redistributePair(a, b, delta, min = 12) {
  const sum = a + b
  let na = Math.max(min, a + delta)
  let nb = sum - na
  if (nb < min) {
    nb = min
    na = sum - nb
  }
  return [na, nb]
}

function TableFieldPreview({ field, selected, onFieldUpdate, containerStyle }) {
  const cols = field.tableColumns || []
  const rows = field.tableRows || []
  const wrapRef = useRef(null)

  const totalW = cols.reduce((s, c) => s + tableColWidthPx(c), 0)
  const totalH = rows.reduce((s, r) => s + tableRowHeightPx(r), 0)

  const startColDrag = (e, boundaryIndex) => {
    e.stopPropagation()
    e.preventDefault()
    if (!onFieldUpdate || cols.length < 2) return
    const startX = e.clientX
    const w0 = tableColWidthPx(cols[boundaryIndex])
    const w1 = tableColWidthPx(cols[boundaryIndex + 1])
    const wrap = wrapRef.current
    const tableW = wrap?.clientWidth ?? 1
    const scale = totalW / Math.max(tableW, 1)

    const move = (ev) => {
      const logicalDelta = (ev.clientX - startX) * scale
      const [na, nb] = redistributePair(w0, w1, logicalDelta)
      const nextCols = cols.map((c, j) => {
        if (j === boundaryIndex) return { ...c, width: na }
        if (j === boundaryIndex + 1) return { ...c, width: nb }
        return c
      })
      onFieldUpdate({ tableColumns: nextCols })
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const startRowDrag = (e, boundaryIndex) => {
    e.stopPropagation()
    e.preventDefault()
    if (!onFieldUpdate || rows.length < 2) return
    const startY = e.clientY
    const h0 = tableRowHeightPx(rows[boundaryIndex])
    const h1 = tableRowHeightPx(rows[boundaryIndex + 1])
    const wrap = wrapRef.current
    const tableH = wrap?.clientHeight ?? 1
    const scale = totalH / Math.max(tableH, 1)

    const move = (ev) => {
      const logicalDelta = (ev.clientY - startY) * scale
      const [na, nb] = redistributePair(h0, h1, logicalDelta)
      const nextRows = rows.map((r, j) => {
        if (j === boundaryIndex) return { ...r, height: na }
        if (j === boundaryIndex + 1) return { ...r, height: nb }
        return r
      })
      onFieldUpdate({ tableRows: nextRows })
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  if (!cols.length || !rows.length || totalW <= 0 || totalH <= 0) {
    return (
      <div style={{ ...containerStyle, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span className="fb-table-preview-empty">Table</span>
      </div>
    )
  }

  let cumW = 0
  const colHandleLeftPct = []
  for (let i = 0; i < cols.length - 1; i++) {
    cumW += tableColWidthPx(cols[i])
    colHandleLeftPct.push((cumW / totalW) * 100)
  }

  let cumH = 0
  const rowHandleTopPct = []
  for (let i = 0; i < rows.length - 1; i++) {
    cumH += tableRowHeightPx(rows[i])
    rowHandleTopPct.push((cumH / totalH) * 100)
  }

  const { rowIds, colIds, covered, spanOf } = buildTableMergeLayout(field)

  return (
    <div style={{ ...containerStyle, alignItems: 'stretch' }}>
      <div ref={wrapRef} className="fb-table-preview-interactive">
        <table className="fb-table-preview fb-table-preview-data-only" style={{ tableLayout: 'fixed', width: '100%', height: '100%' }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.id} style={{ width: `${(tableColWidthPx(c) / totalW) * 100}%` }} />
            ))}
          </colgroup>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.id} style={{ height: `${(tableRowHeightPx(r) / totalH) * 100}%` }}>
                {colIds.map((colId) => {
                  const cellKey = tableCellKey(rowIds[ri], colId)
                  if (covered.has(cellKey)) return null
                  const span = spanOf.get(cellKey)
                  const rs = span?.rowspan || 1
                  const cs = span?.colspan || 1
                  const isMerged = rs > 1 || cs > 1
                  return (
                    <td
                      key={cellKey}
                      rowSpan={rs}
                      colSpan={cs}
                      className={isMerged ? 'fb-table-preview-td--merged' : undefined}
                    >
                      <span
                        className={`fb-table-preview-cell${isMerged ? ' fb-table-preview-cell--merged' : ''}`}
                        title={isMerged ? `Merged ${rs}×${cs}` : undefined}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {selected && onFieldUpdate && (
          <>
            {colHandleLeftPct.map((leftPct, i) => (
              <div
                key={`col-res-${i}`}
                className="fb-table-resize-v"
                style={{ left: `${leftPct}%` }}
                title="Drag to resize columns"
                onMouseDown={(e) => startColDrag(e, i)}
              />
            ))}
            {rowHandleTopPct.map((topPct, i) => (
              <div
                key={`row-res-${i}`}
                className="fb-table-resize-h"
                style={{ top: `${topPct}%` }}
                title="Drag to resize rows"
                onMouseDown={(e) => startRowDrag(e, i)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** Drop merges that no longer fit row/column ids or grid bounds. */
function pruneMerges(merges, rowIds, colIds) {
  const rids = rowIds || []
  const cids = colIds || []
  return (merges || []).filter((m) => {
    const ri = rids.indexOf(m.anchorRowId)
    const ci = cids.indexOf(m.anchorColId)
    if (ri < 0 || ci < 0) return false
    const rs = Math.max(1, parseInt(m.rowspan, 10) || 1)
    const cs = Math.max(1, parseInt(m.colspan, 10) || 1)
    return ri + rs <= rids.length && ci + cs <= cids.length
  })
}

function TableFieldProperties({ field, onUpdate }) {
  const cols = field.tableColumns || []
  const rows = field.tableRows || []
  const merges = field.tableMerges || []
  const rowIds = rows.map((r) => r.id)
  const colIds = cols.map((c) => c.id)

  if (!cols.length || !rows.length) {
    return (
      <div className="fb-form-group">
        <p className="fb-hint">This table needs at least one row and one column.</p>
        <button
          type="button"
          className="fb-btn fb-btn-success"
          onClick={() =>
            onUpdate({
              tableColumns: [
                { id: newTablePartId(), label: 'Column 1', width: DEFAULT_TABLE_COL_WIDTH },
                { id: newTablePartId(), label: 'Column 2', width: DEFAULT_TABLE_COL_WIDTH },
              ],
              tableRows: [{ id: newTablePartId(), label: 'Row 1', height: DEFAULT_TABLE_ROW_HEIGHT }],
              tableMerges: [],
            })
          }
        >
          Initialize table structure
        </button>
      </div>
    )
  }

  const setCols = (next) => {
    onUpdate({
      tableColumns: next,
      tableMerges: pruneMerges(merges, rows.map((r) => r.id), next.map((c) => c.id)),
    })
  }
  const setRows = (next) => {
    onUpdate({
      tableRows: next,
      tableMerges: pruneMerges(merges, next.map((r) => r.id), cols.map((c) => c.id)),
    })
  }

  return (
    <>
      <div className="fb-form-group">
        <label>Columns</label>
        <p className="fb-hint">
          Column names are for this panel and data entry, not the PDF. Set width (px) or drag the vertical
          handles on the table in the builder.
        </p>
        {cols.map((c, i) => (
          <div key={c.id} className="fb-table-axis-row">
            <input
              type="text"
              value={c.label}
              onChange={(e) => {
                const next = cols.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                setCols(next)
              }}
            />
            <label className="fb-table-dim-label" title="Column width in pixels">
              W
              <input
                type="number"
                className="fb-table-dim-input"
                min={12}
                max={2000}
                value={tableColWidthPx(c)}
                onChange={(e) => {
                  const w = Math.max(12, parseInt(e.target.value, 10) || DEFAULT_TABLE_COL_WIDTH)
                  const next = cols.map((x, j) => (j === i ? { ...x, width: w } : x))
                  setCols(next)
                }}
              />
            </label>
            <button
              type="button"
              className="fb-table-remove-btn"
              disabled={cols.length <= 1}
              title={cols.length <= 1 ? 'At least one column required' : 'Remove column'}
              onClick={() => {
                if (cols.length <= 1) return
                setCols(cols.filter((_, j) => j !== i))
              }}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          className="fb-link-btn"
          onClick={() =>
            setCols([
              ...cols,
              { id: newTablePartId(), label: `Column ${cols.length + 1}`, width: DEFAULT_TABLE_COL_WIDTH },
            ])
          }
        >
          + Add column
        </button>
      </div>

      <div className="fb-form-group">
        <label>Rows</label>
        <p className="fb-hint">
          Set row height (px) here, or select the field and drag the horizontal handles on the table on the
          canvas.
        </p>
        {rows.map((r, i) => (
          <div key={r.id} className="fb-table-axis-row">
            <input
              type="text"
              value={r.label}
              onChange={(e) => {
                const next = rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                setRows(next)
              }}
            />
            <label className="fb-table-dim-label" title="Row height in pixels">
              H
              <input
                type="number"
                className="fb-table-dim-input"
                min={12}
                max={2000}
                value={tableRowHeightPx(r)}
                onChange={(e) => {
                  const h = Math.max(12, parseInt(e.target.value, 10) || DEFAULT_TABLE_ROW_HEIGHT)
                  const next = rows.map((x, j) => (j === i ? { ...x, height: h } : x))
                  setRows(next)
                }}
              />
            </label>
            <button
              type="button"
              className="fb-table-remove-btn"
              disabled={rows.length <= 1}
              title={rows.length <= 1 ? 'At least one row required' : 'Remove row'}
              onClick={() => {
                if (rows.length <= 1) return
                setRows(rows.filter((_, j) => j !== i))
              }}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          className="fb-link-btn"
          onClick={() =>
            setRows([
              ...rows,
              { id: newTablePartId(), label: `Row ${rows.length + 1}`, height: DEFAULT_TABLE_ROW_HEIGHT },
            ])
          }
        >
          + Add row
        </button>
      </div>

      <div className="fb-form-group">
        <label>Merged cells</label>
        <p className="fb-hint">
          Anchor cell holds the value; rowspan and colspan must fit inside the grid. Overlapping merges are not
          validated here—avoid crossing regions.
        </p>
        {merges.map((m, idx) => (
          <div key={idx} className="fb-table-merge-row">
            <select
              value={m.anchorRowId}
              onChange={(e) => {
                const next = merges.map((x, j) =>
                  j === idx ? { ...x, anchorRowId: e.target.value } : x,
                )
                onUpdate({ tableMerges: pruneMerges(next, rowIds, colIds) })
              }}
            >
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              value={m.anchorColId}
              onChange={(e) => {
                const next = merges.map((x, j) =>
                  j === idx ? { ...x, anchorColId: e.target.value } : x,
                )
                onUpdate({ tableMerges: pruneMerges(next, rowIds, colIds) })
              }}
            >
              {cols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="fb-table-merge-num">
              R
              <input
                type="number"
                min={1}
                value={m.rowspan ?? 1}
                onChange={(e) => {
                  const rowspan = Math.max(1, parseInt(e.target.value, 10) || 1)
                  const next = merges.map((x, j) => (j === idx ? { ...x, rowspan } : x))
                  onUpdate({ tableMerges: pruneMerges(next, rowIds, colIds) })
                }}
              />
            </label>
            <label className="fb-table-merge-num">
              C
              <input
                type="number"
                min={1}
                value={m.colspan ?? 1}
                onChange={(e) => {
                  const colspan = Math.max(1, parseInt(e.target.value, 10) || 1)
                  const next = merges.map((x, j) => (j === idx ? { ...x, colspan } : x))
                  onUpdate({ tableMerges: pruneMerges(next, rowIds, colIds) })
                }}
              />
            </label>
            <button
              type="button"
              className="fb-table-remove-btn"
              onClick={() => onUpdate({ tableMerges: merges.filter((_, j) => j !== idx) })}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          className="fb-link-btn"
          disabled={!rowIds.length || !colIds.length}
          onClick={() =>
            onUpdate({
              tableMerges: [
                ...merges,
                {
                  anchorRowId: rowIds[0],
                  anchorColId: colIds[0],
                  rowspan: 1,
                  colspan: 1,
                },
              ],
            })
          }
        >
          + Add merge
        </button>
      </div>
    </>
  )
}

function formatDate(dateString) {
  if (!dateString) return 'Unknown'
  const d = new Date(dateString)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function FormBuilder() {
  const { prefs, updatePrefs } = useUserPrefs()
  const [searchParams] = useSearchParams()
  const pdfFile = searchParams.get('file')
  const urlFormId = searchParams.get('formId')
  const urlName = searchParams.get('name')

  const pdfRef = useRef(null)
  const overlayRef = useRef(null)
  const canvasScrollRef = useRef(null)
  /** Saved when changing pages; applied in handlePageRendered after the new page paints (avoids jump on first load). */
  const pendingCanvasScrollRestoreRef = useRef(null)
  const pendingFieldScrollToRef = useRef(null)

  const [fields, setFields] = useState([])
  const [selectedFieldId, setSelectedFieldId] = useState(null)
  const [scale, setScale] = useState(1.5)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [sourceFormIds, setSourceFormIds] = useState([])
  const [loadedFormName, setLoadedFormName] = useState(urlName || null)

  // Modal states
  const [showSelectionModal, setShowSelectionModal] = useState(true)
  const [selectionMode, setSelectionMode] = useState(null)
  const [availableForms, setAvailableForms] = useState([])
  const [selectionFormId, setSelectionFormId] = useState(null)
  const [formsLoading, setFormsLoading] = useState(true)

  const [showSaveModal, setShowSaveModal] = useState(false)
  const [allFormNames, setAllFormNames] = useState([])
  const [allFormsData, setAllFormsData] = useState([])
  const [saveFormName, setSaveFormName] = useState('')
  const [saveFormNameNew, setSaveFormNameNew] = useState('')
  const [saveFormNameMode, setSaveFormNameMode] = useState('select')
  const [saveDescription, setSaveDescription] = useState('')
  const [saveUserName, setSaveUserName] = useState('')
  const [saveSelectedFormId, setSaveSelectedFormId] = useState('')
  const [saveCreateNewVersion, setSaveCreateNewVersion] = useState(false)
  const [saving, setSaving] = useState(false)
  const [componentsPanelCollapsed, setComponentsPanelCollapsed] = useState(false)
  const [propertiesPanelCollapsed, setPropertiesPanelCollapsed] = useState(false)
  const [propertiesPanelWidth, setPropertiesPanelWidth] = useState(PROPERTIES_PANEL_DEFAULT_W)
  const [propertiesPanelResizing, setPropertiesPanelResizing] = useState(false)
  const propertiesPanelWidthRef = useRef(PROPERTIES_PANEL_DEFAULT_W)
  const propertiesResizeRef = useRef({ active: false, startX: 0, startW: PROPERTIES_PANEL_DEFAULT_W })

  // Drag/resize state via refs to avoid re-renders during drag
  const dragState = useRef({ active: false, fieldId: null, offsetX: 0, offsetY: 0 })
  const resizeState = useRef({ active: false, fieldId: null, startX: 0, startY: 0, startW: 0, startH: 0 })

  // Alignment guides (snap to other fields)
  const [guides, setGuides] = useState([])
  // Position guidelines (dragged field edges for ruler alignment)
  const [positionGuides, setPositionGuides] = useState(null)

  const selectedField = useMemo(
    () => fields.find((f) => f.id === selectedFieldId) || null,
    [fields, selectedFieldId],
  )

  useEffect(() => {
    propertiesPanelWidthRef.current = propertiesPanelWidth
  }, [propertiesPanelWidth])

  const storedPanelW = prefs[PROPERTIES_PANEL_WIDTH_STORAGE_KEY]
  useEffect(() => {
    if (propertiesResizeRef.current.active) return
    const raw = storedPanelW
    const n = parseInt(typeof raw === 'string' ? raw : String(raw || ''), 10)
    if (!Number.isFinite(n)) return
    const w = Math.min(PROPERTIES_PANEL_MAX_W, Math.max(PROPERTIES_PANEL_MIN_W, n))
    propertiesPanelWidthRef.current = w
    setPropertiesPanelWidth(w)
  }, [storedPanelW])

  const endPropertiesResize = useCallback(() => {
    if (!propertiesResizeRef.current.active) return
    propertiesResizeRef.current.active = false
    setPropertiesPanelResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    updatePrefs({ [PROPERTIES_PANEL_WIDTH_STORAGE_KEY]: String(propertiesPanelWidthRef.current) })
  }, [updatePrefs])

  useEffect(() => {
    const move = (e) => {
      if (!propertiesResizeRef.current.active) return
      const clientX =
        'touches' in e && e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX
      if (e.type === 'touchmove' && e.cancelable) e.preventDefault()
      const { startX, startW } = propertiesResizeRef.current
      const dx = startX - clientX
      const next = Math.min(
        PROPERTIES_PANEL_MAX_W,
        Math.max(PROPERTIES_PANEL_MIN_W, startW + dx),
      )
      propertiesPanelWidthRef.current = next
      setPropertiesPanelWidth(next)
    }
    const up = () => endPropertiesResize()

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', up)

    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (propertiesResizeRef.current.active) {
        propertiesResizeRef.current.active = false
        setPropertiesPanelResizing(false)
      }
    }
  }, [endPropertiesResize])

  const onPropertiesResizePointerDown = useCallback(
    (e) => {
      if (propertiesPanelCollapsed) return
      e.preventDefault()
      const clientX =
        'touches' in e && e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX
      propertiesResizeRef.current = {
        active: true,
        startX: clientX,
        startW: propertiesPanelWidthRef.current,
      }
      setPropertiesPanelResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [propertiesPanelCollapsed],
  )

  const scaleFactor = scale / DESIGN_SCALE

  // Load available forms on mount
  useEffect(() => {
    if (!pdfFile) return
    setFormsLoading(true)
    listForms()
      .then((data) => {
        if (data.success && data.forms) {
          const forPdf = data.forms.filter((f) => f.pdfFile === pdfFile)
          setAvailableForms(forPdf)
          if (forPdf.length === 0) {
            setSelectionMode('new')
          }
        }
      })
      .catch(() => {})
      .finally(() => setFormsLoading(false))
  }, [pdfFile])

  // If formId in URL, skip modal and load directly
  useEffect(() => {
    if (urlFormId && pdfFile) {
      setShowSelectionModal(false)
      loadFormById(urlFormId).then((data) => {
        if (data.success && data.form?.fields) {
          setLoadedFormName(data.form.name || null)
          setSourceFormIds(data.form.sourceFormIds?.length ? data.form.sourceFormIds : [urlFormId])
          setFields(
            normalizeFieldGroupOrder(
              data.form.fields.map((f) => ({ ...f, page: f.page || 1 })),
            ),
          )
        }
      })
    }
  }, [urlFormId, pdfFile])

  // Pre-fill user name from server-backed prefs
  useEffect(() => {
    const name = prefs.ebrUserDisplayName
    if (name) setSaveUserName(String(name))
  }, [prefs.ebrUserDisplayName])

  const handlePageRendered = useCallback(({ page, width, height, totalPages: n }) => {
    setCurrentPage(page)
    setCanvasSize({ width, height })
    if (n != null) setTotalPages(n)

    const saved = pendingCanvasScrollRestoreRef.current
    const hadSavedScroll = saved != null
    if (saved != null) {
      pendingCanvasScrollRestoreRef.current = null
      const scrollRef = canvasScrollRef
      const apply = () => {
        const el = scrollRef.current
        if (el) el.scrollTop = saved
      }
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

    const scrollToField = pendingFieldScrollToRef.current
    if (scrollToField) {
      const fieldIdToScroll = scrollToField
      pendingFieldScrollToRef.current = null
      const doScroll = () => {
        const el = document.querySelector(`[data-fb-field-id="${fieldIdToScroll}"]`)
        el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      }
      const base = hadSavedScroll ? 450 : 0
      setTimeout(doScroll, base)
      setTimeout(doScroll, base + 100)
      setTimeout(doScroll, base + 400)
    }
  }, [])

  const goToPdfPage = useCallback((page) => {
    pendingCanvasScrollRestoreRef.current = canvasScrollRef.current?.scrollTop ?? 0
    pdfRef.current?.goToPage?.(page)
  }, [])

  const focusFieldOnCanvas = useCallback(
    (field) => {
      if (!field) return
      setSelectedFieldId(field.id)
      const p = field.page || 1
      if (p !== currentPage) {
        pendingFieldScrollToRef.current = field.id
        goToPdfPage(p)
      } else {
        const doScroll = () => {
          const el = document.querySelector(`[data-fb-field-id="${field.id}"]`)
          el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
        }
        requestAnimationFrame(() => {
          doScroll()
          setTimeout(doScroll, 0)
          setTimeout(doScroll, 100)
        })
      }
    },
    [currentPage, goToPdfPage],
  )

  // Zoom handlers
  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 3.0))
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5))
  const resetZoom = () => setScale(1.5)

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn() }
        else if (e.key === '-') { e.preventDefault(); zoomOut() }
        else if (e.key === '0') { e.preventDefault(); resetZoom() }
      }
      if (e.key === 'Escape') {
        if (showSaveModal) setShowSaveModal(false)
      }
      if (e.key === 'Delete' && selectedFieldId) {
        setFields((prev) => normalizeFieldGroupOrder(prev.filter((f) => f.id !== selectedFieldId)))
        setSelectedFieldId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showSaveModal, selectedFieldId])

  // Ctrl+scroll zoom on canvas
  const handleCanvasWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      if (e.deltaY < 0) setScale((s) => Math.min(s + 0.25, 3.0))
      else setScale((s) => Math.max(s - 0.25, 0.5))
    }
  }, [])

  // -- Field CRUD --

  const addField = useCallback((type, pixelX, pixelY, page) => {
    const config = DEFAULT_CONFIGS[type] || DEFAULT_CONFIGS.text
    const designX = (pixelX * DESIGN_SCALE) / scale
    const designY = (pixelY * DESIGN_SCALE) / scale
    const maxDesignX = (canvasSize.width * DESIGN_SCALE) / scale - config.width
    const maxDesignY = (canvasSize.height * DESIGN_SCALE) / scale - config.height
    const newField = {
      id: 'field_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type,
      page,
      x: Math.max(0, Math.min(designX, maxDesignX)),
      y: Math.max(0, Math.min(designY, maxDesignY)),
      width: config.width,
      height: config.height,
      label: config.label,
      required: true,
      stageInProcess: '',
      stageOrder: null,
      placeholder: config.placeholder || '',
      unit: config.unit ?? '',
      options: config.options ? [...config.options] : undefined,
      inputFontSize: config.inputFontSize ?? DEFAULT_INPUT_FONT_PX,
    }
    if (type === 'table') {
      newField.tableColumns = [
        { id: newTablePartId(), label: 'Column 1', width: DEFAULT_TABLE_COL_WIDTH },
        { id: newTablePartId(), label: 'Column 2', width: DEFAULT_TABLE_COL_WIDTH },
      ]
      newField.tableRows = [
        { id: newTablePartId(), label: 'Row 1', height: DEFAULT_TABLE_ROW_HEIGHT },
        { id: newTablePartId(), label: 'Row 2', height: DEFAULT_TABLE_ROW_HEIGHT },
      ]
      newField.tableMerges = []
    }
    setFields((prev) => {
      const maxO = prev
        .filter((f) => !f.stageInProcess?.trim())
        .reduce((m, f) => Math.max(m, Number(f.orderInGroup) || 0), 0)
      return [...prev, { ...newField, orderInGroup: maxO + 1 }]
    })
    setSelectedFieldId(newField.id)
  }, [canvasSize, scale])

  const updateField = useCallback((id, updates) => {
    setFields((prev) => {
      const f0 = prev.find((f) => f.id === id)
      if (!f0) return prev
      if (updates.stageInProcess === undefined) {
        return prev.map((f) => (f.id === id ? { ...f, ...updates } : f))
      }
      const newStage = (updates.stageInProcess || '').trim()
      if (stageKey(f0) === newStage) {
        return prev.map((f) => (f.id === id ? { ...f, ...updates } : f))
      }
      return placeFieldInGroupOrder(prev, id, newStage, null, true, stageKey(f0), updates)
    })
  }, [])

  const deleteField = useCallback((id) => {
    setFields((prev) => normalizeFieldGroupOrder(prev.filter((f) => f.id !== id)))
    setSelectedFieldId((prev) => (prev === id ? null : prev))
  }, [])

  // -- Snap logic --

  const snapToAlignment = useCallback((pixelX, pixelY, fieldId, fieldWidth, fieldHeight, scaleFactor) => {
    let snappedX = pixelX
    let snappedY = pixelY
    const newGuides = []

    const currentPageFields = fields.filter((f) => f.page === currentPage && f.id !== fieldId)
    for (const f of currentPageFields) {
      const fx = f.x * scaleFactor
      const fy = f.y * scaleFactor
      const fw = f.width * scaleFactor
      const fh = f.height * scaleFactor
      // Top edge to top edge
      if (Math.abs(pixelY - fy) < SNAP_THRESHOLD) {
        snappedY = fy
        newGuides.push({ type: 'horizontal', pos: fy })
      }
      if (Math.abs((pixelY + fieldHeight) - (fy + fh)) < SNAP_THRESHOLD) {
        snappedY = fy + fh - fieldHeight
        newGuides.push({ type: 'horizontal', pos: fy + fh })
      }
      if (Math.abs(pixelY - (fy + fh)) < SNAP_THRESHOLD) {
        snappedY = fy + fh
        newGuides.push({ type: 'horizontal', pos: fy + fh })
      }
      if (Math.abs(pixelX - fx) < SNAP_THRESHOLD) {
        snappedX = fx
        newGuides.push({ type: 'vertical', pos: fx })
      }
      if (Math.abs((pixelX + fieldWidth) - (fx + fw)) < SNAP_THRESHOLD) {
        snappedX = fx + fw - fieldWidth
        newGuides.push({ type: 'vertical', pos: fx + fw })
      }
      if (Math.abs(pixelX - (fx + fw)) < SNAP_THRESHOLD) {
        snappedX = fx + fw
        newGuides.push({ type: 'vertical', pos: fx + fw })
      }
    }

    setGuides(newGuides)
    return { x: snappedX, y: snappedY }
  }, [fields, currentPage])

  /** Snap bottom-right resize to other fields' edges and canvas bounds; returns guides for overlay */
  const snapResizeDimensions = useCallback(
    (field, tentativeW, tentativeH, scaleFactor) => {
      const leftPx = field.x * scaleFactor
      const topPx = field.y * scaleFactor
      const minWPx = 100 * scaleFactor
      const minHPx = 30 * scaleFactor
      const maxRightPx = canvasSize.width
      const maxBottomPx = canvasSize.height

      let rightPx = leftPx + tentativeW * scaleFactor
      let bottomPx = topPx + tentativeH * scaleFactor
      rightPx = Math.min(rightPx, maxRightPx)
      bottomPx = Math.min(bottomPx, maxBottomPx)

      const snapXs = [maxRightPx]
      const snapYs = [maxBottomPx]
      for (const f of fields) {
        if (f.id === field.id || f.page !== currentPage) continue
        const fx = f.x * scaleFactor
        const fy = f.y * scaleFactor
        const fw = f.width * scaleFactor
        const fh = f.height * scaleFactor
        snapXs.push(fx, fx + fw)
        snapYs.push(fy, fy + fh)
      }

      const snapCoord = (value, targets) => {
        let best = value
        let bestD = SNAP_THRESHOLD + 1
        let matched = null
        for (const t of targets) {
          const d = Math.abs(value - t)
          if (d < bestD && d < SNAP_THRESHOLD) {
            bestD = d
            best = t
            matched = t
          }
        }
        return { value: best, matched }
      }

      const r = snapCoord(rightPx, snapXs)
      rightPx = r.value
      const snappedRightMatch = r.matched

      const b = snapCoord(bottomPx, snapYs)
      bottomPx = b.value
      const snappedBottomMatch = b.matched

      if (rightPx - leftPx < minWPx) rightPx = leftPx + minWPx
      if (bottomPx - topPx < minHPx) bottomPx = topPx + minHPx

      rightPx = Math.min(rightPx, maxRightPx)
      bottomPx = Math.min(bottomPx, maxBottomPx)

      const newGuides = []
      if (snappedRightMatch != null && Math.abs(rightPx - snappedRightMatch) < 2) {
        newGuides.push({ type: 'vertical', pos: snappedRightMatch })
      }
      if (snappedBottomMatch != null && Math.abs(bottomPx - snappedBottomMatch) < 2) {
        newGuides.push({ type: 'horizontal', pos: snappedBottomMatch })
      }

      const width = (rightPx - leftPx) / scaleFactor
      const height = (bottomPx - topPx) / scaleFactor

      return {
        width,
        height,
        guides: newGuides,
        positionGuides: {
          left: leftPx,
          top: topPx,
          right: rightPx,
          bottom: bottomPx,
        },
      }
    },
    [fields, currentPage, canvasSize],
  )

  // -- Mouse handlers for drag/resize --

  useEffect(() => {
    const scaleFactor = scale / DESIGN_SCALE
    const handleMouseMove = (e) => {
      if (dragState.current.active) {
        const overlay = overlayRef.current
        if (!overlay) return
        const rect = overlay.getBoundingClientRect()
        const field = fields.find((f) => f.id === dragState.current.fieldId)
        if (!field) return

        let pixelX = e.clientX - rect.left - dragState.current.offsetX
        let pixelY = e.clientY - rect.top - dragState.current.offsetY
        const fieldWidthPx = field.width * scaleFactor
        const fieldHeightPx = field.height * scaleFactor

        const snapped = snapToAlignment(pixelX, pixelY, field.id, fieldWidthPx, fieldHeightPx, scaleFactor)
        pixelX = snapped.x
        pixelY = snapped.y

        const designX = (pixelX * DESIGN_SCALE) / scale
        const designY = (pixelY * DESIGN_SCALE) / scale
        const maxDesignX = (canvasSize.width * DESIGN_SCALE) / scale - field.width
        const maxDesignY = (canvasSize.height * DESIGN_SCALE) / scale - field.height
        const clampedX = Math.max(0, Math.min(designX, maxDesignX))
        const clampedY = Math.max(0, Math.min(designY, maxDesignY))

        updateField(field.id, { x: clampedX, y: clampedY })
        setPositionGuides({
          left: clampedX * scaleFactor,
          top: clampedY * scaleFactor,
          right: (clampedX + field.width) * scaleFactor,
          bottom: (clampedY + field.height) * scaleFactor,
        })
      }

      if (resizeState.current.active) {
        const field = fields.find((f) => f.id === resizeState.current.fieldId)
        if (!field) return

        const deltaX = e.clientX - resizeState.current.startX
        const deltaY = e.clientY - resizeState.current.startY
        const newDesignWidth = Math.max(100, resizeState.current.startW + deltaX / scaleFactor)
        const newDesignHeight = Math.max(30, resizeState.current.startH + deltaY / scaleFactor)
        const maxDesignWidth = (canvasSize.width * DESIGN_SCALE) / scale - field.x
        const maxDesignHeight = (canvasSize.height * DESIGN_SCALE) / scale - field.y

        const clampedW = Math.min(newDesignWidth, maxDesignWidth)
        const clampedH = Math.min(newDesignHeight, maxDesignHeight)
        const snapped = snapResizeDimensions(field, clampedW, clampedH, scaleFactor)

        setGuides(snapped.guides)
        setPositionGuides(snapped.positionGuides)
        updateField(field.id, {
          width: snapped.width,
          height: snapped.height,
        })
      }
    }

    const handleMouseUp = () => {
      dragState.current.active = false
      resizeState.current.active = false
      setGuides([])
      setPositionGuides(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [fields, canvasSize, snapToAlignment, snapResizeDimensions, updateField, scale])

  // -- Drop from components panel --

  const handleOverlayDragEnter = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleOverlayDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleOverlayDrop = (e) => {
    e.preventDefault()
    const componentType = e.dataTransfer.getData('component-type') || e.dataTransfer.getData('text/plain')
    if (!componentType) return
    const overlay = overlayRef.current
    if (!overlay) return
    const rect = overlay.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    addField(componentType, x, y, currentPage)
  }

  // -- Field mousedown for dragging --

  const handleFieldMouseDown = (e, field) => {
    if (
      e.target.classList.contains('fb-field-resize') ||
      e.target.classList.contains('fb-field-delete') ||
      e.target.closest('.fb-field-delete')
    ) return
    if (e.target.closest('.fb-table-resize-v') || e.target.closest('.fb-table-resize-h')) return
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return

    e.preventDefault()
    const overlay = overlayRef.current
    if (!overlay) return
    const fieldEl = e.currentTarget
    const fieldRect = fieldEl.getBoundingClientRect()

    dragState.current = {
      active: true,
      fieldId: field.id,
      offsetX: e.clientX - fieldRect.left,
      offsetY: e.clientY - fieldRect.top,
    }
    setSelectedFieldId(field.id)
  }

  const handleResizeMouseDown = (e, field) => {
    e.stopPropagation()
    setSelectedFieldId(field.id)
    resizeState.current = {
      active: true,
      fieldId: field.id,
      startX: e.clientX,
      startY: e.clientY,
      startW: field.width,
      startH: field.height,
    }
  }

  // Click overlay background to deselect
  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) {
      setSelectedFieldId(null)
    }
  }

  // -- Form Selection Modal Logic --

  const confirmSelection = () => {
    setShowSelectionModal(false)
    if (selectionMode === 'new') {
      try {
        const raw = sessionStorage.getItem(EBR_PENDING_SUGGESTIONS_KEY)
        if (raw) {
          sessionStorage.removeItem(EBR_PENDING_SUGGESTIONS_KEY)
          const o = JSON.parse(raw)
          if (
            o &&
            o.pdfFilename === pdfFile &&
            Array.isArray(o.fields) &&
            o.fields.length > 0
          ) {
            setFields(
              normalizeFieldGroupOrder(
                o.fields.map((f) => ({ ...f, page: f.page || 1 })),
              ),
            )
            return
          }
        }
      } catch {
        /* ignore invalid import payload */
      }
      setFields([])
    } else if (selectionMode === 'existing' && selectionFormId) {
      loadFormById(selectionFormId).then((data) => {
        if (data.success && data.form?.fields) {
          setLoadedFormName(data.form.name || null)
          setSourceFormIds(
            data.form.sourceFormIds?.length ? data.form.sourceFormIds : [selectionFormId],
          )
          setFields(
            normalizeFieldGroupOrder(
              data.form.fields.map((f) => ({ ...f, page: f.page || 1 })),
            ),
          )
        }
      })
    }
  }

  // -- Save Modal Logic --

  const openSaveModal = async () => {
    setShowSaveModal(true)
    setSaveFormName(loadedFormName || '')
    setSaveFormNameNew('')
    setSaveFormNameMode(loadedFormName ? 'select' : 'select')
    setSaveDescription('')
    setSaveSelectedFormId('')
    setSaveCreateNewVersion(false)

    try {
      const data = await listForms()
      if (data.success && data.forms) {
        setAllFormsData(data.forms)
        const names = [...new Set(data.forms.map((f) => f.name))].sort()
        setAllFormNames(names)

        if (loadedFormName) {
          const match = data.forms.find(
            (f) => f.name === loadedFormName && f.pdfFile === pdfFile && f.isLatest,
          )
          if (match) {
            setSaveSelectedFormId(match.id)
          }
        }
      }
    } catch {}
  }

  const getVersionPreview = () => {
    const name = saveFormNameMode === 'new' ? saveFormNameNew : saveFormName
    if (!name?.trim()) return null
    const matching = allFormsData.filter((f) => f.name === name && f.pdfFile === pdfFile)
    if (matching.length === 0) {
      return { text: 'This will create a new form (Version 1)', type: 'new' }
    }
    const maxVersion = Math.max(...matching.map((f) => f.version || 1))
    return {
      text: `This form already exists. Next version will be: Version ${maxVersion + 1}`,
      type: 'existing',
    }
  }

  const handleConfirmSave = async () => {
    const finalName = saveFormNameMode === 'new' ? saveFormNameNew.trim() : saveFormName.trim()
    if (!finalName) { alert('Please select or enter a form name'); return }
    if (!saveUserName.trim()) { alert('Please enter your name for the audit trail'); return }

    setSaving(true)
    updatePrefs({ ebrUserDisplayName: saveUserName.trim() })

    try {
      const body = {
        name: finalName,
        description: saveDescription.trim(),
        pdfFile,
        fields,
        formId: saveSelectedFormId || null,
        createNewVersion: saveCreateNewVersion && saveSelectedFormId ? true : false,
        userName: saveUserName.trim(),
        sourceFormIds: sourceFormIds.length > 0 ? sourceFormIds : undefined,
        isCombined: sourceFormIds.length > 1,
        createdAt: new Date().toISOString(),
      }
      const result = await saveForm(body)
      if (result.success) {
        alert(saveSelectedFormId ? 'Form updated successfully!' : 'Form saved successfully!')
        setLoadedFormName(finalName)
        setShowSaveModal(false)
      } else {
        alert('Error saving form: ' + (result.message || 'Unknown error'))
      }
    } catch (err) {
      alert('Error saving form: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // -- Stages (order matches form; used in properties + left panel) --

  const existingStages = useMemo(() => buildOrderedStageNames(fields), [fields])
  const unassignedFields = useMemo(() => sortFieldsInGroupList(fields, ''), [fields])

  const dragFieldIdRef = useRef(null)
  const dragStageNameRef = useRef(null)

  const moveFieldToStageById = useCallback((fieldId, targetStageName) => {
    setFields((prev) =>
      placeFieldInGroupOrder(prev, fieldId, String(targetStageName || '').trim(), null, true),
    )
  }, [])

  const reorderStagesByName = useCallback((sourceName, targetName) => {
    if (!sourceName || !targetName || sourceName === targetName) return
    setFields((prev) => {
      const list = buildOrderedStageNames(prev)
      const from = list.indexOf(sourceName)
      const to = list.indexOf(targetName)
      if (from < 0 || to < 0) return prev
      const next = reorderStringArray(list, from, to)
      return applyStageNameOrderToFields(next)(prev)
    })
  }, [])

  const clearPanelDragRefs = useCallback(() => {
    dragFieldIdRef.current = null
    dragStageNameRef.current = null
  }, [])

  const showStagesSection = fields.length > 0

  // -- Grouped forms for selection modal --

  const groupedAvailableForms = useMemo(() => {
    const grouped = {}
    availableForms.forEach((f) => {
      if (!grouped[f.name]) grouped[f.name] = []
      grouped[f.name].push(f)
    })
    Object.values(grouped).forEach((arr) => arr.sort((a, b) => (b.version || 1) - (a.version || 1)))
    return grouped
  }, [availableForms])

  // -- No file guard --

  if (!pdfFile) {
    return (
      <div className="page-content">
        <h1 className="page-title">Form Builder</h1>
        <p className="error-message">
          No template selected. Choose a template from <Link to="/templates">Templates</Link> or{' '}
          <Link to="/forms/build">Build Form</Link>.
        </p>
      </div>
    )
  }

  // Fields for the current page
  const pageFields = fields.filter((f) => f.page === currentPage)

  return (
    <div className="fb-root">
      {/* Header */}
      <div className="fb-header">
        <h1>Form Builder</h1>
        <div className="fb-header-actions">
          <button className="fb-btn fb-btn-success" onClick={openSaveModal}>
            Save Form
          </button>
          <Link to="/templates" className="fb-btn fb-btn-ghost">
            &larr; Back
          </Link>
        </div>
      </div>

      <div className="fb-main">
        {/* Components Panel - collapsible; vertical toggle on right edge */}
        <div className={`fb-components-panel ${componentsPanelCollapsed ? 'fb-components-panel-collapsed' : ''}`}>
          {!componentsPanelCollapsed && (
            <div className="fb-components-panel-content">
              <div className="fb-components-panel-inner">
                {showStagesSection && (
                  <section className="fb-stages-section" aria-label="Form stages">
                    <h2 className="fb-components-section-title">Stages</h2>
                    <div className="fb-stages-section-scroll">
                      <div
                        className="fb-stage-block"
                        data-stage=""
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          const id = dragFieldIdRef.current
                          if (id) {
                            moveFieldToStageById(id, '')
                            clearPanelDragRefs()
                          }
                        }}
                      >
                        <div className="fb-stage-block-header fb-stage-block-header--static">
                          <span className="fb-stage-block-title">Unassigned</span>
                          <span className="fb-stage-block-count">{unassignedFields.length}</span>
                        </div>
                        {unassignedFields.length === 0 ? (
                          <p
                            className="fb-stage-block-empty"
                            onDragOver={(e) => {
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                            }}
                          >
                            Drop a field here to clear its stage.
                          </p>
                        ) : (
                          <ul
                            className="fb-stage-field-list"
                            onDragOver={(e) => {
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                            }}
                            onDrop={(e) => {
                              if (e.target !== e.currentTarget) return
                              e.preventDefault()
                              e.stopPropagation()
                              const id = dragFieldIdRef.current
                              if (id) {
                                setFields((prev) => placeFieldInGroupOrder(prev, id, '', null, true))
                                clearPanelDragRefs()
                              }
                            }}
                          >
                            {unassignedFields.map((f) => (
                              <li
                                key={f.id}
                                className="fb-stage-field-item"
                                onDragOver={(e) => {
                                  e.preventDefault()
                                  e.dataTransfer.dropEffect = 'move'
                                }}
                                onDrop={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  const id = dragFieldIdRef.current
                                  if (!id || id === f.id) {
                                    clearPanelDragRefs()
                                    return
                                  }
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  const before = e.clientY < rect.top + rect.height / 2
                                  setFields((prev) => placeFieldInGroupOrder(prev, id, '', f.id, before))
                                  clearPanelDragRefs()
                                }}
                              >
                                <span className="fb-stage-field-pill">
                                  <span
                                    className="fb-stage-field-pill-grip"
                                    draggable
                                    onDragStart={(e) => {
                                      e.stopPropagation()
                                      dragFieldIdRef.current = f.id
                                      e.dataTransfer.effectAllowed = 'move'
                                      e.dataTransfer.setData('text/plain', f.id)
                                    }}
                                    onDragEnd={clearPanelDragRefs}
                                    title="Drag to move or reorder"
                                  >
                                    <Bars3Icon className="fb-stage-pill-grip-icon" aria-hidden />
                                  </span>
                                  <button
                                    type="button"
                                    className="fb-stage-field-pill-label"
                                    onClick={() => focusFieldOnCanvas(f)}
                                  >
                                    {f.label || getComponentTypeLabel(f.type)}
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {existingStages.map((stageName) => {
                        const inStage = sortFieldsInGroupList(fields, stageName)
                        return (
                          <div
                            key={stageName}
                            className="fb-stage-block"
                            data-stage={stageName}
                            onDragOver={(e) => {
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                            }}
                            onDrop={(e) => {
                              e.preventDefault()
                              const id = dragFieldIdRef.current
                              if (id) {
                                moveFieldToStageById(id, stageName)
                                clearPanelDragRefs()
                                return
                              }
                              const src = dragStageNameRef.current
                              if (src && src !== stageName) {
                                reorderStagesByName(src, stageName)
                                clearPanelDragRefs()
                              }
                            }}
                          >
                            <div
                              className="fb-stage-block-header"
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation()
                                dragStageNameRef.current = stageName
                                e.dataTransfer.effectAllowed = 'move'
                                e.dataTransfer.setData('text/plain', `stage:${stageName}`)
                              }}
                              onDragEnd={clearPanelDragRefs}
                            >
                              <Bars3Icon className="fb-stage-grip" aria-hidden />
                              <span className="fb-stage-block-title" title="Drag to reorder stages">
                                {stageName}
                              </span>
                              <span className="fb-stage-block-count">{inStage.length}</span>
                            </div>
                            <ul
                              className="fb-stage-field-list"
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                              }}
                              onDrop={(e) => {
                                if (e.target !== e.currentTarget) return
                                e.preventDefault()
                                e.stopPropagation()
                                const id = dragFieldIdRef.current
                                if (id) {
                                  setFields((prev) =>
                                    placeFieldInGroupOrder(prev, id, stageName, null, true),
                                  )
                                  clearPanelDragRefs()
                                }
                              }}
                            >
                              {inStage.map((f) => (
                                <li
                                  key={f.id}
                                  className="fb-stage-field-item"
                                  onDragOver={(e) => {
                                    e.preventDefault()
                                    e.dataTransfer.dropEffect = 'move'
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const id = dragFieldIdRef.current
                                    if (!id || id === f.id) {
                                      clearPanelDragRefs()
                                      return
                                    }
                                    const rect = e.currentTarget.getBoundingClientRect()
                                    const before = e.clientY < rect.top + rect.height / 2
                                    setFields((prev) =>
                                      placeFieldInGroupOrder(prev, id, stageName, f.id, before),
                                    )
                                    clearPanelDragRefs()
                                  }}
                                >
                                  <span className="fb-stage-field-pill">
                                    <span
                                      className="fb-stage-field-pill-grip"
                                      draggable
                                      onDragStart={(e) => {
                                        e.stopPropagation()
                                        dragFieldIdRef.current = f.id
                                        e.dataTransfer.effectAllowed = 'move'
                                        e.dataTransfer.setData('text/plain', f.id)
                                      }}
                                      onDragEnd={clearPanelDragRefs}
                                      title="Drag to move or reorder"
                                    >
                                      <Bars3Icon className="fb-stage-pill-grip-icon" aria-hidden />
                                    </span>
                                    <button
                                      type="button"
                                      className="fb-stage-field-pill-label"
                                      onClick={() => focusFieldOnCanvas(f)}
                                    >
                                      {f.label || getComponentTypeLabel(f.type)}
                                    </button>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )
                      })}

                    </div>
                  </section>
                )}

                <section
                  className="fb-palette-section"
                  aria-label="Field components to place on the PDF"
                >
                  <h2 className="fb-components-section-title">Components</h2>
                  {canvasSize.width > 0 && canvasSize.height > 0 && (
                    <p className="fb-drag-hint">Drag onto the PDF to add a field.</p>
                  )}
                  <div className="fb-palette-list">
                    {COMPONENT_TYPES.map((c) => {
                      const Icon = c.Icon
                      return (
                        <div
                          key={c.type}
                          className="fb-component-item"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('component-type', c.type)
                            e.dataTransfer.setData('text/plain', c.type)
                            e.dataTransfer.effectAllowed = 'copy'
                          }}
                        >
                          <Icon className="fb-component-icon" />
                          <span className="fb-component-name">{c.name}</span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              </div>
            </div>
          )}
          <button
            type="button"
            className="fb-components-panel-toggle"
            onClick={() => setComponentsPanelCollapsed((c) => !c)}
            title={componentsPanelCollapsed ? 'Expand components' : 'Collapse components'}
            aria-label={componentsPanelCollapsed ? 'Expand components' : 'Collapse components'}
          >
            <span className="fb-components-panel-toggle-line">
              <span className="fb-components-panel-toggle-label">{componentsPanelCollapsed ? 'Components' : ''}</span>
              {componentsPanelCollapsed ? (
                <ChevronDoubleRightIcon className="fb-components-panel-toggle-chevron" />
              ) : (
                <ChevronDoubleLeftIcon className="fb-components-panel-toggle-chevron" />
              )}
            </span>
          </button>
        </div>

        {/* Canvas Area */}
        <div className="fb-canvas-area" onWheel={handleCanvasWheel}>
          <div className="fb-canvas-scroll" ref={canvasScrollRef}>
          <div className="fb-rulers-and-canvas">
            {/* Top ruler (sticky when scrolling down) */}
            {canvasSize.width > 0 && canvasSize.height > 0 && (
              <div className="fb-ruler-top-row">
                <div className="fb-ruler-corner" />
                <div
                  className="fb-ruler fb-ruler-top"
                  style={{ width: canvasSize.width, height: RULER_SIZE }}
                >
                  {Array.from({ length: Math.ceil(canvasSize.width / RULER_TICK_INTERVAL) + 1 }, (_, i) => {
                    const x = i * RULER_TICK_INTERVAL
                    if (x > canvasSize.width) return null
                    const isMajor = x % RULER_LABEL_INTERVAL === 0
                    return (
                      <div
                        key={x}
                        className={`fb-ruler-tick fb-ruler-tick-top ${isMajor ? 'major' : ''}`}
                        style={{ left: x }}
                      >
                        {isMajor && <span className="fb-ruler-label">{x}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="fb-ruler-body-row">
              {/* Left ruler */}
              {canvasSize.width > 0 && canvasSize.height > 0 && (
                <div
                  className="fb-ruler fb-ruler-left"
                  style={{ width: RULER_SIZE, height: canvasSize.height }}
                >
                  {Array.from({ length: Math.ceil(canvasSize.height / RULER_TICK_INTERVAL) + 1 }, (_, i) => {
                    const y = i * RULER_TICK_INTERVAL
                    if (y > canvasSize.height) return null
                    const isMajor = y % RULER_LABEL_INTERVAL === 0
                    return (
                      <div
                        key={y}
                        className={`fb-ruler-tick fb-ruler-tick-left ${isMajor ? 'major' : ''}`}
                        style={{ top: y }}
                      >
                        {isMajor && <span className="fb-ruler-label">{y}</span>}
                      </div>
                    )
                  })}
                </div>
              )}
              <PdfViewer
            ref={pdfRef}
            pdfUrl={`/uploads/${pdfFile}`}
            scale={scale}
            onPageRendered={handlePageRendered}
            paginationPosition="both"
            hidePagination={totalPages <= 1}
            zoomControls={
              <PdfZoomControls
                className="fb-zoom-controls"
                scale={scale}
                onScaleChange={setScale}
                minScale={0.5}
                maxScale={3}
                defaultScale={1.5}
                resetIcon
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
            {/* Overlay */}
            <div
              ref={overlayRef}
              className="fb-overlay"
              style={{ width: canvasSize.width, height: canvasSize.height }}
              onDragEnter={handleOverlayDragEnter}
              onDragOver={handleOverlayDragOver}
              onDrop={handleOverlayDrop}
              onClick={handleOverlayClick}
            >
              {/* Alignment guides (snap to other fields) */}
              {guides.map((g, i) =>
                g.type === 'horizontal' ? (
                  <div
                    key={`guide-${i}`}
                    className="fb-alignment-guide fb-alignment-guide-h"
                    style={{ top: g.pos, width: canvasSize.width }}
                  />
                ) : (
                  <div
                    key={`guide-${i}`}
                    className="fb-alignment-guide fb-alignment-guide-v"
                    style={{ left: g.pos, height: canvasSize.height }}
                  />
                ),
              )}

              {/* Position guidelines (dragged field edges) */}
              {positionGuides && (
                <>
                  <div
                    className="fb-position-guide fb-position-guide-h"
                    style={{ top: positionGuides.top, width: canvasSize.width }}
                  />
                  <div
                    className="fb-position-guide fb-position-guide-h"
                    style={{ top: positionGuides.bottom, width: canvasSize.width }}
                  />
                  <div
                    className="fb-position-guide fb-position-guide-v"
                    style={{ left: positionGuides.left, height: canvasSize.height }}
                  />
                  <div
                    className="fb-position-guide fb-position-guide-v"
                    style={{ left: positionGuides.right, height: canvasSize.height }}
                  />
                </>
              )}

              {/* Form fields */}
              {pageFields.map((field) => (
                <FormField
                  key={field.id}
                  field={field}
                  selected={selectedFieldId === field.id}
                  scaleFactor={scaleFactor}
                  onFieldUpdate={(updates) => updateField(field.id, updates)}
                  onMouseDown={(e) => handleFieldMouseDown(e, field)}
                  onResizeMouseDown={(e) => handleResizeMouseDown(e, field)}
                  onDelete={() => deleteField(field.id)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedFieldId(field.id)
                  }}
                />
              ))}
            </div>
          </PdfViewer>
            </div>
          </div>
          </div>
        </div>

        {/* Properties Panel - only visible when a field is selected; collapsible like components */}
        {selectedField && (
          <div
            className={`fb-properties-panel${propertiesPanelCollapsed ? ' fb-properties-panel-collapsed' : ''}${
              propertiesPanelResizing ? ' fb-properties-panel--resizing' : ''
            }`}
            style={
              propertiesPanelCollapsed
                ? undefined
                : { width: propertiesPanelWidth, minWidth: propertiesPanelWidth, flexShrink: 0 }
            }
          >
            <button
              type="button"
              className="fb-properties-panel-toggle"
              onClick={() => setPropertiesPanelCollapsed((c) => !c)}
              title={propertiesPanelCollapsed ? 'Expand properties' : 'Collapse properties'}
              aria-label={propertiesPanelCollapsed ? 'Expand properties' : 'Collapse properties'}
            >
              <span className="fb-properties-panel-toggle-line">
                <span className="fb-properties-panel-toggle-label">
                  {propertiesPanelCollapsed ? 'Properties' : ''}
                </span>
                {propertiesPanelCollapsed ? (
                  <ChevronDoubleLeftIcon className="fb-properties-panel-toggle-chevron" />
                ) : (
                  <ChevronDoubleRightIcon className="fb-properties-panel-toggle-chevron" />
                )}
              </span>
            </button>
            {!propertiesPanelCollapsed && (
              <>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize properties panel"
                  title="Drag to resize"
                  className="fb-properties-panel-resize"
                  onMouseDown={onPropertiesResizePointerDown}
                  onTouchStart={onPropertiesResizePointerDown}
                />
                <div className="fb-properties-panel-content">
                  <h2 className="fb-properties-panel-title">Properties</h2>
                  <PropertiesForm
                    field={selectedField}
                    existingStages={existingStages}
                    fields={fields}
                    onUpdate={(updates) => updateField(selectedField.id, updates)}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Form Selection Modal */}
      {showSelectionModal && !urlFormId && (
        <div className="fb-modal-backdrop" onClick={() => {}}>
          <div className="fb-selection-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Start Form Builder</h2>
            <p>Choose how you want to start building your form:</p>

            <div className="fb-selection-options">
              <div
                className={`fb-selection-option ${selectionMode === 'new' ? 'selected' : ''}`}
                onClick={() => {
                  setSelectionMode('new')
                  setSelectionFormId(null)
                }}
              >
                <h3>Start New Form</h3>
                <p>Create a completely new form from scratch</p>
              </div>
              {(availableForms.length > 0 || formsLoading) && (
                <div
                  className={`fb-selection-option ${selectionMode === 'existing' ? 'selected' : ''}`}
                  onClick={() => setSelectionMode('existing')}
                >
                  <h3>Load Existing Form</h3>
                  <p>Continue editing an existing form or version</p>
                </div>
              )}
            </div>

            {selectionMode === 'existing' && (
              <div className="fb-existing-forms-list">
                <h3>Select a form to load:</h3>
                {formsLoading ? (
                  <p className="fb-loading-text">Loading forms...</p>
                ) : (
                  Object.entries(groupedAvailableForms).map(([name, versions]) => (
                    <div key={name}>
                      {versions.map((form) => {
                        const isLatest =
                          form.isLatest || form.version === versions[0].version
                        return (
                          <div
                            key={form.id}
                            className={`fb-existing-form-item ${selectionFormId === form.id ? 'selected' : ''}`}
                            onClick={() => setSelectionFormId(form.id)}
                          >
                            <div className="fb-existing-form-header">
                              <span className="fb-existing-form-name">{form.name}</span>
                              <span
                                className={`fb-version-badge ${isLatest ? 'latest' : 'older'}`}
                              >
                                v{form.version || 1}
                                {isLatest ? ' - LATEST' : ''}
                              </span>
                            </div>
                            <div className="fb-existing-form-meta">
                              {form.fieldCount || 0} fields &bull; Updated:{' '}
                              {formatDate(form.updatedAt)}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="fb-selection-actions">
              <button
                className="fb-btn fb-btn-success"
                disabled={
                  !selectionMode ||
                  (selectionMode === 'existing' && !selectionFormId)
                }
                onClick={confirmSelection}
              >
                Continue
              </button>
              <Link to="/templates" className="fb-btn fb-btn-cancel">
                Cancel
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Save Modal */}
      {showSaveModal && (
        <div className="fb-modal-backdrop" onClick={() => setShowSaveModal(false)}>
          <div className="fb-save-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="fb-modal-close"
              onClick={() => setShowSaveModal(false)}
              title="Close"
            >
              &times;
            </button>
            <h3>Save Form Configuration</h3>

            <div className="fb-form-group">
              <label>Form Name:</label>
              {saveFormNameMode === 'select' ? (
                <select
                  value={saveFormName}
                  onChange={(e) => {
                    if (e.target.value === '__NEW__') {
                      setSaveFormNameMode('new')
                      setSaveFormName('')
                      setSaveSelectedFormId('')
                    } else {
                      setSaveFormName(e.target.value)
                      const match = allFormsData.find(
                        (f) => f.name === e.target.value && f.pdfFile === pdfFile && f.isLatest,
                      )
                      setSaveSelectedFormId(match?.id || '')
                    }
                  }}
                >
                  <option value="">-- Select or enter new form name --</option>
                  <option value="__NEW__">Add new form name...</option>
                  {allFormNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : (
                <div>
                  <input
                    type="text"
                    value={saveFormNameNew}
                    onChange={(e) => setSaveFormNameNew(e.target.value)}
                    placeholder="Enter new form name"
                    autoFocus
                  />
                  <button
                    className="fb-link-btn"
                    onClick={() => {
                      setSaveFormNameMode('select')
                      setSaveFormName(loadedFormName || '')
                    }}
                  >
                    Back to list
                  </button>
                </div>
              )}
              {(() => {
                const preview = getVersionPreview()
                if (!preview) return null
                return (
                  <div
                    className={`fb-version-preview ${preview.type === 'new' ? 'new' : 'existing'}`}
                  >
                    {preview.text}
                  </div>
                )
              })()}
              <small className="fb-hint">
                Select an existing form name or choose &ldquo;Add new...&rdquo; to create a new form name
              </small>
            </div>

            <div className="fb-form-group">
              <label>Description (optional):</label>
              <textarea
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
                placeholder="Enter description"
              />
            </div>

            <div className="fb-form-group">
              <label>Your Name (required for audit trail):</label>
              <input
                type="text"
                value={saveUserName}
                onChange={(e) => setSaveUserName(e.target.value)}
                placeholder="Enter your name"
                required
              />
              <small className="fb-hint">
                This will be recorded in the audit trail for tracking changes
              </small>
            </div>

            {saveSelectedFormId && (
              <div className="fb-version-options">
                <h4>Save Options:</h4>
                <div className="fb-version-option">
                  <label>
                    <input
                      type="radio"
                      name="saveOption"
                      checked={!saveCreateNewVersion}
                      onChange={() => setSaveCreateNewVersion(false)}
                    />
                    Save as new version (recommended)
                  </label>
                  <div className="fb-version-option-desc">
                    Creates a new minor version with audit trail.
                  </div>
                </div>
                <div className="fb-version-option">
                  <label>
                    <input
                      type="radio"
                      name="saveOption"
                      checked={saveCreateNewVersion}
                      onChange={() => setSaveCreateNewVersion(true)}
                    />
                    Create new version explicitly
                  </label>
                  <div className="fb-version-option-desc">
                    Explicitly create a new version
                  </div>
                </div>
              </div>
            )}

            <div className="fb-modal-actions">
              <button
                className="fb-btn fb-btn-success"
                onClick={handleConfirmSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                className="fb-btn fb-btn-cancel"
                onClick={() => setShowSaveModal(false)}
                disabled={saving}
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

// -- FormField sub-component --

function formFieldFontPx(field) {
  const n = Number(field?.inputFontSize)
  if (field?.inputFontSize != null && !Number.isNaN(n) && n > 0) {
    return Math.min(48, Math.max(8, Math.round(n)))
  }
  return DEFAULT_INPUT_FONT_PX
}

function FormField({ field, selected, scaleFactor = 1, onFieldUpdate, onMouseDown, onResizeMouseDown, onDelete, onClick }) {
  const fontPx = formFieldFontPx(field)
  return (
    <div
      className={`fb-field ${selected ? 'selected' : ''}`}
      data-fb-field-id={field.id}
      aria-label={field.label || 'Field'}
      style={{
        left: field.x * scaleFactor,
        top: field.y * scaleFactor,
        width: field.width * scaleFactor,
        height: field.height * scaleFactor,
        ['--fb-field-font-size']: `${fontPx}px`,
      }}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      <FieldPreview
        field={field}
        selected={selected}
        onFieldUpdate={onFieldUpdate}
        renderTablePreview={({ field: f, selected: s, onFieldUpdate: uf, containerStyle }) => (
          <TableFieldPreview field={f} selected={s} onFieldUpdate={uf} containerStyle={containerStyle} />
        )}
      />
      <div className="fb-field-resize" onMouseDown={onResizeMouseDown} />
      {selected && (
        <button
          className="fb-field-delete"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          &times;
        </button>
      )}
    </div>
  )
}

// -- Properties Form sub-component --

/** If another field already uses this stage name, return its stageOrder so new fields stay aligned. */
function stageOrderForExistingStageName(fields, stageNameTrimmed, excludeFieldId) {
  const sn = String(stageNameTrimmed || '').trim()
  if (!sn) return null
  for (const f of fields || []) {
    if (f.id === excludeFieldId) continue
    if (String(f.stageInProcess || '').trim() !== sn) continue
    const n = Number(f.stageOrder)
    if (Number.isFinite(n)) return n
  }
  return null
}

function PropertiesForm({ field, existingStages, fields, onUpdate }) {
  const [stageMode, setStageMode] = useState(
    field.stageInProcess && !existingStages.includes(field.stageInProcess) ? 'new' : 'select',
  )
  const [newStageValue, setNewStageValue] = useState(
    field.stageInProcess && !existingStages.includes(field.stageInProcess)
      ? field.stageInProcess
      : '',
  )

  // Reset local state when field changes
  useEffect(() => {
    const isExisting = existingStages.includes(field.stageInProcess)
    setStageMode(field.stageInProcess && !isExisting ? 'new' : 'select')
    setNewStageValue(field.stageInProcess && !isExisting ? field.stageInProcess : '')
  }, [field.id, field.stageInProcess, existingStages])

  const suggestedNextOrder = useMemo(() => nextUnusedStageOrder(fields), [fields])

  return (
    <div className="fb-properties-form">
      <div className="fb-form-group">
        <label>Data Label (Field Name):</label>
        <input
          type="text"
          value={field.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
        />
      </div>

      <div className="fb-form-group">
        <label>Stage in Process:</label>
        {stageMode === 'select' ? (
          <select
            value={field.stageInProcess || ''}
            onChange={(e) => {
              if (e.target.value === '__NEW__') {
                setStageMode('new')
                setNewStageValue('')
              } else if (e.target.value === '') {
                onUpdate({ stageInProcess: '', stageOrder: null })
              } else {
                const name = e.target.value
                if (name === field.stageInProcess) return
                const shared = stageOrderForExistingStageName(fields, name, field.id)
                const next = nextUnusedStageOrder(fields)
                onUpdate({
                  stageInProcess: name,
                  stageOrder: shared != null ? shared : next,
                })
              }
            }}
          >
            <option value="">-- Select or enter new stage --</option>
            <option value="__NEW__">Add new stage...</option>
            {existingStages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <div>
            <input
              type="text"
              value={newStageValue}
              placeholder="Enter new stage name"
              onChange={(e) => setNewStageValue(e.target.value)}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v) {
                  const shared = stageOrderForExistingStageName(fields, v, field.id)
                  const next = nextUnusedStageOrder(fields)
                  onUpdate({
                    stageInProcess: v,
                    stageOrder: shared != null ? shared : next,
                  })
                } else {
                  setStageMode('select')
                  onUpdate({ stageInProcess: '', stageOrder: null })
                }
              }}
              autoFocus
            />
            <button
              className="fb-link-btn"
              onClick={() => {
                setStageMode('select')
                if (!newStageValue.trim()) onUpdate({ stageInProcess: '', stageOrder: null })
              }}
            >
              Back to list
            </button>
          </div>
        )}
        <small className="fb-hint">
          Fields with the same stage name are grouped together.
        </small>
      </div>

      <div className="fb-form-group">
        <label>Stage Order:</label>
        <input
          type="number"
          value={field.stageOrder ?? ''}
          placeholder={String(suggestedNextOrder)}
          onChange={(e) =>
            onUpdate({ stageOrder: e.target.value === '' ? null : parseInt(e.target.value, 10) })
          }
        />
        <small className="fb-hint">
          Sequential order (1, 2, 3…). Choosing a stage sets this automatically: same number as other
          fields in that stage, or the next free number for a new stage (placeholder shows the next free).
        </small>
      </div>

      <div className="fb-form-group">
        <label>Order in Stages list:</label>
        <input
          type="number"
          value={field.orderInGroup ?? ''}
          readOnly
          className="fb-disabled-input"
        />
        <small className="fb-hint">
          Row-major order in the Stages panel: 1 = top-left, then left to right; the next row continues
          the sequence (1, 2, 3…). Reorder by dragging.
        </small>
      </div>

      <div className="fb-form-group fb-grid-2">
        <div>
          <label>X:</label>
          <input
            type="number"
            value={Math.round(field.x)}
            onChange={(e) => onUpdate({ x: parseInt(e.target.value, 10) || 0 })}
          />
        </div>
        <div>
          <label>Y:</label>
          <input
            type="number"
            value={Math.round(field.y)}
            onChange={(e) => onUpdate({ y: parseInt(e.target.value, 10) || 0 })}
          />
        </div>
      </div>

      <div className="fb-form-group fb-grid-2">
        <div>
          <label>Width:</label>
          <input
            type="number"
            value={Math.round(field.width)}
            onChange={(e) => onUpdate({ width: Math.max(100, parseInt(e.target.value, 10) || 100) })}
          />
        </div>
        <div>
          <label>Height:</label>
          <input
            type="number"
            value={Math.round(field.height)}
            onChange={(e) => onUpdate({ height: Math.max(30, parseInt(e.target.value, 10) || 30) })}
          />
        </div>
      </div>

      <div className="fb-form-group">
        <label>Input font size (px):</label>
        <input
          type="number"
          min={8}
          max={48}
          value={field.inputFontSize ?? DEFAULT_INPUT_FONT_PX}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            if (Number.isNaN(v)) onUpdate({ inputFontSize: DEFAULT_INPUT_FONT_PX })
            else onUpdate({ inputFontSize: Math.min(48, Math.max(8, v)) })
          }}
        />
        <small className="fb-hint">
          Preview on the PDF and data entry use this size for field text and placeholders.
        </small>
      </div>

      <div className="fb-form-group">
        <label className="fb-checkbox-label">
          <input
            type="checkbox"
            checked={field.required || false}
            onChange={(e) => onUpdate({ required: e.target.checked })}
          />
          Required Field
        </label>
      </div>

      <div className="fb-form-group">
        <label>Page:</label>
        <input type="number" value={field.page || 1} disabled className="fb-disabled-input" />
        <small className="fb-hint">Field is on page {field.page || 1}</small>
      </div>

      {/* Type-specific */}
      {(field.type === 'text' || field.type === 'textarea') && (
        <div className="fb-form-group">
          <label>Placeholder:</label>
          <input
            type="text"
            value={field.placeholder || ''}
            onChange={(e) => onUpdate({ placeholder: e.target.value })}
          />
        </div>
      )}

      {field.type === 'number' && (
        <div className="fb-form-group">
          <label>Unit of Measurement:</label>
          <select
            value={field.unit || ''}
            onChange={(e) => onUpdate({ unit: e.target.value })}
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u || 'None'}
              </option>
            ))}
          </select>
        </div>
      )}

      {(field.type === 'dropdown' || field.type === 'radio' || field.type === 'multiselect') && (
        <div className="fb-form-group">
          <label>Options (one per line):</label>
          <textarea
            value={(field.options || []).join('\n')}
            onChange={(e) =>
              onUpdate({ options: e.target.value.split('\n').filter((o) => o.trim()) })
            }
          />
        </div>
      )}

      {field.type === 'time' && (
        <div className="fb-form-group">
          <label>Placeholder:</label>
          <input
            type="text"
            value={field.placeholder || ''}
            onChange={(e) => onUpdate({ placeholder: e.target.value })}
            placeholder="e.g. HH:MM"
          />
        </div>
      )}

      {field.type === 'collaborator' && (
        <div className="fb-form-group">
          <label>Help text (shown on form):</label>
          <textarea
            rows={2}
            value={field.helpText || ''}
            onChange={(e) => onUpdate({ helpText: e.target.value })}
            placeholder="Optional instructions for analysts"
          />
          <small className="fb-hint">
            Manage users under <strong>Active Users</strong> in the nav.
          </small>
        </div>
      )}

      {field.type === 'table' && <TableFieldProperties field={field} onUpdate={onUpdate} />}
    </div>
  )
}
