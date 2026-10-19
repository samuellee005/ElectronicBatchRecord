import { useEffect, useMemo, useRef, useState } from 'react'
import './FieldListTable.css'

/**
 * Split spreadsheet text into rows of cells. `delim` separates cells (a tab for
 * clipboard text, a comma for a CSV file) and newlines separate rows; a cell
 * wrapped in double quotes may hold delimiters, newlines and "" (an escaped
 * quote), which is how Excel and Google Sheets write a cell with a line break.
 */
function parseDelimited(text, delim = '\t') {
  const rows = []
  let row = []
  let cell = ''
  let i = 0
  let atCellStart = true
  while (i < text.length) {
    const ch = text[i]
    if (atCellStart && ch === '"') {
      // Quoted cell: read to the closing quote.
      i += 1
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            cell += '"'
            i += 2
            continue
          }
          i += 1
          break
        }
        cell += text[i]
        i += 1
      }
      atCellStart = false
      continue
    }
    if (ch === delim) {
      row.push(cell)
      cell = ''
      atCellStart = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atCellStart = true
    } else {
      cell += ch
      atCellStart = false
    }
    i += 1
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function delimitedCell(v, delim) {
  const t = String(v ?? '')
  return t.includes(delim) || /[\n\r"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/** A file name made from the form name, safe on every OS. */
function exportFileName(base) {
  const stem = String(base || 'form').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'form'
  return `${stem} - fields.csv`
}

const TRUE_WORDS = new Set(['y', 'yes', 'true', '1', 'x', '✓', '✔', 'req', 'required'])
const FALSE_WORDS = new Set(['', 'n', 'no', 'false', '0', '-', '—'])

/**
 * The table's columns in on-screen order, as copy and paste see them. `paste`
 * turns a cell's text into a patch for that field; columns without it are
 * positions or read-only and are skipped when pasting (positions would fight
 * each other if a whole column of them were applied at once).
 */
const COLUMNS = [
  {
    key: 'name',
    header: 'Name',
    aliases: ['name', 'label', 'field', 'field name'],
    copy: (f) => f.label || '',
    paste: (v) => ({ label: v.trim() }),
  },
  {
    key: 'type',
    header: 'Type',
    aliases: ['type'],
    copyOnly: true,
    copy: (f, typeLabelOf) => typeLabelOf(f.type) || '',
  },
  {
    key: 'stage',
    header: 'Stage in process',
    aliases: ['stage in process', 'stage'],
    copy: (f) => (f.stageInProcess || '').trim(),
    paste: (v) => ({ stageInProcess: v.trim() }),
  },
  {
    key: 'stageOrder',
    header: 'Stage order',
    aliases: ['stage order'],
    copy: (f) => ((f.stageInProcess || '').trim() ? (f.stageOrder ?? '') : ''),
  },
  {
    key: 'inList',
    header: 'In list',
    aliases: ['in list', 'position'],
    copy: (f) => f.orderInGroup ?? '',
  },
  {
    key: 'req',
    header: 'Req',
    aliases: ['req', 'required'],
    copy: (f) => (f.required === true ? 'Yes' : 'No'),
    paste: (v) => {
      const w = v.trim().toLowerCase()
      if (TRUE_WORDS.has(w)) return { required: true }
      if (FALSE_WORDS.has(w)) return { required: false }
      return null
    },
  },
  {
    key: 'page',
    header: 'Page',
    aliases: ['page'],
    copy: (f) => f.page || 1,
  },
  {
    key: 'id',
    header: 'ID',
    aliases: ['id'],
    copyOnly: true,
    copy: (f) => f.id,
  },
]
// Columns a paste walks across, left to right from the cell it starts in.
const GRID_COLUMNS = COLUMNS.filter((c) => !c.copyOnly)
const columnForHeader = (text) => {
  const h = String(text || '').trim().toLowerCase()
  return COLUMNS.find((c) => c.aliases.includes(h)) || null
}

/**
 * Column map for a header row, or null when the row is data. A row counts as a
 * header when at least two cells and at least half of the non-blank ones name
 * a column, so a sheet with an extra notes column added still reads as one;
 * unknown columns are ignored.
 */
function headerColumns(cells) {
  const cols = cells.map(columnForHeader)
  const known = cols.filter(Boolean).length
  const filled = cells.filter((c) => String(c).trim() !== '').length
  return known >= 2 && known * 2 >= filled ? cols : null
}

/**
 * A 1-based position cell that commits on blur or Enter rather than per
 * keystroke.
 *
 * Committing as you type would be wrong here: both position columns *move*
 * something, so typing "12" would first move the row to 1 (re-sorting the table
 * under the cursor, and logging an undo step) before ever seeing the 2. The
 * draft is reseeded whenever the committed value changes, so a move made
 * elsewhere still shows up.
 */
function PositionInput({ value, max, label, title, disabled, onCommit }) {
  const text = value == null ? '' : String(value)
  const [draft, setDraft] = useState(text)
  // Reseed during render rather than in an effect: React's own pattern for
  // derived state, and it avoids a second render pass on every move.
  const [seeded, setSeeded] = useState(value)
  if (value !== seeded) {
    setSeeded(value)
    setDraft(text)
  }

  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n) || n < 1 || n === value) {
      setDraft(text)
      return
    }
    onCommit(n)
  }

  return (
    <input
      type="number"
      min={1}
      max={max}
      className="fb-list-input fb-list-input-num"
      value={draft}
      aria-label={label}
      title={title}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(text)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * The Stages panel's "List" view: every field as one editable row.
 *
 * The point is to skip the click-the-box-then-cross-to-the-properties-panel
 * round trip. A row edits the properties that are otherwise scattered — name,
 * stage, stage order, position in the stage list, Required — and clicking a row
 * takes the document to that field so it is clear which box is being edited.
 *
 * Two of the columns are not per-field values, and the table is explicit about
 * it rather than pretending otherwise:
 *   - Stage order belongs to the whole stage; editing it moves every field in
 *     that stage (`onMoveStage`), exactly as the stage properties panel does.
 *   - In list is a position, not a stored number; editing it reorders the field
 *     within its group (`onMoveFieldInGroup`), the typed equivalent of dragging.
 */
export default function FieldListTable({
  rows,
  exportName,
  existingStages,
  selectedFieldIds,
  stageSizes,
  typeLabelOf,
  onFocusField,
  onUpdateField,
  onMoveStage,
  onMoveFieldInGroup,
  canEdit = true,
}) {
  const [query, setQuery] = useState('')
  // The row whose Stage cell is typing a brand-new stage name.
  const [newStageFor, setNewStageFor] = useState(null)
  const [newStageDraft, setNewStageDraft] = useState('')
  // Result of the last copy / paste, shown briefly in the toolbar.
  const [status, setStatus] = useState(null)
  const statusTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(statusTimerRef.current), [])
  const flash = (message) => {
    setStatus(message)
    clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => setStatus(null), 3500)
  }

  // The table is grouped by stage, so giving a field a new stage would move its
  // row to that stage's group — mid-paste that sends rows jumping about, and a
  // second paste would land on the wrong rows. So once an edit here changes a
  // stage, the rows hold the order they had (new fields go at the end) until
  // Re-sort, a move in a position column, or the List view is reopened.
  const [heldOrder, setHeldOrder] = useState(null)
  const orderedRows = useMemo(() => {
    if (!heldOrder) return rows
    const byId = new Map(rows.map((f) => [f.id, f]))
    const held = new Set(heldOrder)
    return [
      ...heldOrder.map((id) => byId.get(id)).filter(Boolean),
      ...rows.filter((f) => !held.has(f.id)),
    ]
  }, [rows, heldOrder])
  const orderIsHeld =
    heldOrder != null && orderedRows.some((f, i) => rows[i]?.id !== f.id)
  const holdOrder = () => setHeldOrder((cur) => cur ?? orderedRows.map((f) => f.id))
  const releaseOrder = () => setHeldOrder(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orderedRows
    return orderedRows.filter((f) => {
      const stage = (f.stageInProcess || '').trim()
      return (
        String(f.label || '').toLowerCase().includes(q) ||
        stage.toLowerCase().includes(q) ||
        String(typeLabelOf(f.type) || '').toLowerCase().includes(q) ||
        `page ${f.page || 1}`.includes(q)
      )
    })
  }, [orderedRows, query, typeLabelOf])

  // Clicking a row takes the canvas to that field. Skipped when it is already
  // the selected one, so typing in a cell does not keep re-scrolling.
  const focusRow = (f) => {
    if (selectedFieldIds.size === 1 && selectedFieldIds.has(f.id)) return
    onFocusField(f)
  }

  // Copy the rows on screen (after the filter) as tab-separated text with a
  // header row, ready to paste into Excel or Sheets. The ID column lets the
  // same block be pasted back after editing, even if rows were re-sorted.
  const copyTable = async () => {
    const lines = [COLUMNS.map((c) => c.header).join('\t')]
    for (const f of visible) {
      lines.push(COLUMNS.map((c) => delimitedCell(c.copy(f, typeLabelOf), '\t')).join('\t'))
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n') + '\n')
      flash(`Copied ${visible.length} row${visible.length === 1 ? '' : 's'} — paste into a spreadsheet`)
    } catch {
      flash('Could not copy — the browser blocked clipboard access')
    }
  }

  // Export every row (ignoring the filter) as a CSV file to edit in Excel,
  // Sheets or any other application. Bring the results back with Import, or by
  // pasting the cells into the table; the ID column ties each row to its field.
  // Starts with a byte-order mark so Excel reads non-ASCII names correctly.
  const exportCsv = () => {
    const lines = [COLUMNS.map((c) => c.header).join(',')]
    for (const f of rows) {
      lines.push(COLUMNS.map((c) => delimitedCell(c.copy(f, typeLabelOf), ',')).join(','))
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportFileName(exportName)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    flash(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} — edit, then Import or paste back`)
  }

  /**
   * Apply a block of spreadsheet cells to the fields. With a header row (as
   * Copy and Export write) columns are matched by name, and an ID column
   * matches rows by field rather than by where they sit in the table. Without
   * one, cells run right from column `startCol` and down from visible row
   * `startRow`. Returns the summary message.
   */
  const applyGrid = (grid, { startCol = 'name', startRow = 0, requireHeader = false } = {}) => {
    holdOrder()
    let colMap = headerColumns(grid[0] || [])
    if (colMap) {
      grid = grid.slice(1)
    } else if (requireHeader) {
      return 'That file has no header row — export the list first and edit that file'
    } else {
      const start = GRID_COLUMNS.findIndex((c) => c.key === startCol)
      colMap = (grid[0] || []).map((_, j) => GRID_COLUMNS[start + j] || null)
    }
    // A sheet's trailing blank rows are not rows to apply.
    while (grid.length && grid[grid.length - 1].every((c) => String(c).trim() === '')) grid = grid.slice(0, -1)
    const idCol = colMap.findIndex((c) => c?.key === 'id')
    const byId = idCol >= 0 ? new Map(rows.map((f) => [f.id, f])) : null

    let updated = 0
    let unmatched = 0
    const skipped = new Set()
    grid.forEach((cells, i) => {
      const f = byId ? byId.get(String(cells[idCol] || '').trim()) : visible[startRow + i]
      if (!f) {
        unmatched += 1
        return
      }
      const patch = {}
      cells.forEach((v, j) => {
        const col = colMap[j]
        if (!col || col.copyOnly) return
        if (!col.paste) {
          if (String(v).trim() !== String(col.copy(f, typeLabelOf))) skipped.add(col.header)
          return
        }
        const p = col.paste(v)
        if (!p) return
        // Leave a field alone when the cell already matches it.
        for (const [k, val] of Object.entries(p)) {
          const cur = k === 'stageInProcess' ? (f.stageInProcess || '').trim() : f[k]
          if (k === 'label' && val === '') continue
          if (cur !== val && !(k === 'required' && (cur === true) === val)) patch[k] = val
        }
      })
      if (Object.keys(patch).length > 0) {
        onUpdateField(f.id, patch)
        updated += 1
      }
    })

    const parts = [`Updated ${updated} field${updated === 1 ? '' : 's'}`]
    if (unmatched > 0) {
      parts.push(
        byId
          ? `${unmatched} row${unmatched === 1 ? '' : 's'} with an unknown ID ignored`
          : `${unmatched} extra row${unmatched === 1 ? '' : 's'} ignored`,
      )
    }
    if (skipped.size > 0) parts.push(`${[...skipped].join(' and ')} can't be changed this way — edit those in the table`)
    return parts.join(' · ')
  }

  /**
   * Paste a block of cells from a spreadsheet, starting at the focused cell and
   * filling down the rows on screen and across the columns. A single value
   * pasted into a text box is left to the browser.
   */
  const handlePaste = (e) => {
    if (!canEdit) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    const grid = parseDelimited(text, '\t')
    if (grid.length === 0) return
    const multi = grid.length > 1 || grid[0].length > 1
    const target = e.target
    const isTextBox = target.tagName === 'INPUT' && (target.type === 'text' || target.type === 'number')
    if (!multi && isTextBox) return
    const td = target.closest?.('td[data-col]')
    if (!td) return
    e.preventDefault()
    flash(
      applyGrid(grid, {
        startCol: td.dataset.col,
        startRow: Number(td.closest('tr')?.dataset.row ?? 0),
      }),
    )
  }

  // Import a CSV (or tab-separated) file edited elsewhere. It needs the header
  // row Export writes; rows are matched by ID, so their order does not matter.
  const importInputRef = useRef(null)
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !canEdit) return
    try {
      const text = (await file.text()).replace(/^\ufeff/, '')
      const firstLine = text.split(/\r?\n/, 1)[0]
      const delim = /\.tsv$|\.txt$/i.test(file.name) || firstLine.includes('\t') ? '\t' : ','
      const grid = parseDelimited(text, delim)
      flash(grid.length === 0 ? 'That file is empty' : applyGrid(grid, { requireHeader: true }))
    } catch {
      flash('Could not read that file')
    }
  }

  const commitNewStage = (f) => {
    const name = newStageDraft.trim()
    setNewStageFor(null)
    setNewStageDraft('')
    if (name && name !== (f.stageInProcess || '').trim()) {
      holdOrder()
      onUpdateField(f.id, { stageInProcess: name })
    }
  }

  return (
    <div className="fb-list-view">
      <div className="fb-list-toolbar">
        <input
          type="search"
          className="fb-list-search"
          value={query}
          placeholder="Filter by name, stage, type or page…"
          aria-label="Filter fields"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="fb-list-copy-btn"
          onClick={copyTable}
          disabled={visible.length === 0}
          title="Copy these rows as a table to paste into Excel or Sheets. Paste a block back into any cell to fill down and across."
        >
          Copy
        </button>
        <button
          type="button"
          className="fb-list-copy-btn"
          onClick={exportCsv}
          disabled={rows.length === 0}
          title="Download every field as a CSV file to edit in Excel, Sheets or another application. Bring it back with Import, or paste the cells into the table."
        >
          Export
        </button>
        {canEdit && (
          <>
            <button
              type="button"
              className="fb-list-copy-btn"
              onClick={() => importInputRef.current?.click()}
              disabled={rows.length === 0}
              title="Apply an edited export (CSV or tab-separated). Rows are matched by their ID column; Name, Stage and Req are updated."
            >
              Import
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              hidden
              onChange={handleImportFile}
            />
          </>
        )}
        <span className="fb-list-count">
          {visible.length === rows.length
            ? `${rows.length} field${rows.length === 1 ? '' : 's'}`
            : `${visible.length} of ${rows.length}`}
        </span>
      </div>

      {orderIsHeld && (
        <div className="fb-list-held">
          <span>Rows are kept where they were while you edit — some are no longer grouped by stage.</span>
          <button type="button" className="fb-list-copy-btn" onClick={releaseOrder}>
            Re-sort
          </button>
        </div>
      )}

      <p className={`fb-list-hint${status ? ' is-status' : ''}`} role="status" aria-live="polite">
        {status ||
          (canEdit
            ? 'Paste cells from a spreadsheet into a Name, Stage or Req cell to fill down, or Export, edit and Import.'
            : null)}
      </p>

      <div className="fb-list-scroll" onPaste={handlePaste}>
        <table className="fb-list-table">
          <thead>
            <tr>
              <th scope="col" className="fb-list-th-name">Name</th>
              <th scope="col" className="fb-list-th-stage">Stage in process</th>
              <th scope="col" className="fb-list-th-num" title="Position of this field's stage in the completion order. Shared by every field in the stage.">
                Stage order
              </th>
              <th scope="col" className="fb-list-th-num" title="Position of this field inside its stage's list. The typed equivalent of dragging it.">
                In list
              </th>
              <th scope="col" className="fb-list-th-req" title="This field must be filled in before its stage counts as complete">
                Req
              </th>
              <th scope="col" className="fb-list-th-page">Page</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="fb-list-empty">
                  {rows.length === 0
                    ? 'No fields yet — drag a component onto the PDF.'
                    : 'No field matches that filter.'}
                </td>
              </tr>
            )}
            {visible.map((f, rowIndex) => {
              const stage = (f.stageInProcess || '').trim()
              const selected = selectedFieldIds.has(f.id)
              const groupSize = stageSizes.get(stage) || 1
              return (
                <tr
                  key={f.id}
                  data-row={rowIndex}
                  data-list-field-id={f.id}
                  className={`fb-list-row${selected ? ' is-selected' : ''}`}
                  onClick={() => focusRow(f)}
                  onFocusCapture={() => focusRow(f)}
                >
                  <td className="fb-list-cell-name" data-col="name">
                    <input
                      type="text"
                      className="fb-list-input fb-list-input-name"
                      value={f.label || ''}
                      placeholder={typeLabelOf(f.type)}
                      aria-label={`Name of ${f.label || typeLabelOf(f.type)}`}
                      disabled={!canEdit}
                      onChange={(e) => onUpdateField(f.id, { label: e.target.value })}
                    />
                    <span className="fb-list-type">{typeLabelOf(f.type)}</span>
                  </td>

                  <td data-col="stage">
                    {newStageFor === f.id ? (
                      <input
                        type="text"
                        className="fb-list-input"
                        value={newStageDraft}
                        autoFocus
                        placeholder="New stage name"
                        aria-label="New stage name"
                        onChange={(e) => setNewStageDraft(e.target.value)}
                        onBlur={() => commitNewStage(f)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitNewStage(f)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setNewStageFor(null)
                            setNewStageDraft('')
                          }
                        }}
                      />
                    ) : (
                      <select
                        className="fb-list-input"
                        value={stage}
                        aria-label={`Stage of ${f.label || typeLabelOf(f.type)}`}
                        disabled={!canEdit}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === '__NEW__') {
                            setNewStageFor(f.id)
                            setNewStageDraft('')
                          } else if (v !== stage) {
                            holdOrder()
                            onUpdateField(f.id, { stageInProcess: v })
                          }
                        }}
                      >
                        <option value="">— Unassigned —</option>
                        {existingStages.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                        <option value="__NEW__">+ New stage…</option>
                      </select>
                    )}
                  </td>

                  <td data-col="stageOrder">
                    {stage ? (
                      <PositionInput
                        value={f.stageOrder ?? null}
                        max={Math.max(1, existingStages.length)}
                        label={`Order of stage ${stage}`}
                        title={`Moves the whole “${stage}” stage in the completion order (1–${existingStages.length}).`}
                        disabled={!canEdit}
                        onCommit={(n) => {
                          releaseOrder()
                          onMoveStage(stage, n)
                        }}
                      />
                    ) : (
                      <span className="fb-list-dash" title="Unassigned fields have no stage order">
                        —
                      </span>
                    )}
                  </td>

                  <td data-col="inList">
                    <PositionInput
                      value={f.orderInGroup ?? null}
                      max={groupSize}
                      label={`Position of ${f.label || typeLabelOf(f.type)} in its list`}
                      title={`Position in ${stage ? `“${stage}”` : 'Unassigned'} (1–${groupSize}).`}
                      disabled={!canEdit}
                      onCommit={(n) => {
                        releaseOrder()
                        onMoveFieldInGroup(f.id, n)
                      }}
                    />
                  </td>

                  <td className="fb-list-cell-req" data-col="req">
                    <input
                      type="checkbox"
                      className="fb-list-check"
                      checked={f.required === true}
                      aria-label={`${f.label || typeLabelOf(f.type)} is required`}
                      disabled={!canEdit}
                      onChange={(e) => onUpdateField(f.id, { required: e.target.checked })}
                    />
                  </td>

                  <td className="fb-list-cell-page" data-col="page">{f.page || 1}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
