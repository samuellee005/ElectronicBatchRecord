import { useMemo, useState } from 'react'
import './FieldListTable.css'

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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((f) => {
      const stage = (f.stageInProcess || '').trim()
      return (
        String(f.label || '').toLowerCase().includes(q) ||
        stage.toLowerCase().includes(q) ||
        String(typeLabelOf(f.type) || '').toLowerCase().includes(q) ||
        `page ${f.page || 1}`.includes(q)
      )
    })
  }, [rows, query, typeLabelOf])

  // Clicking a row takes the canvas to that field. Skipped when it is already
  // the selected one, so typing in a cell does not keep re-scrolling.
  const focusRow = (f) => {
    if (selectedFieldIds.size === 1 && selectedFieldIds.has(f.id)) return
    onFocusField(f)
  }

  const commitNewStage = (f) => {
    const name = newStageDraft.trim()
    setNewStageFor(null)
    setNewStageDraft('')
    if (name && name !== (f.stageInProcess || '').trim()) {
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
        <span className="fb-list-count">
          {visible.length === rows.length
            ? `${rows.length} field${rows.length === 1 ? '' : 's'}`
            : `${visible.length} of ${rows.length}`}
        </span>
      </div>

      <div className="fb-list-scroll">
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
            {visible.map((f) => {
              const stage = (f.stageInProcess || '').trim()
              const selected = selectedFieldIds.has(f.id)
              const groupSize = stageSizes.get(stage) || 1
              return (
                <tr
                  key={f.id}
                  className={`fb-list-row${selected ? ' is-selected' : ''}`}
                  onClick={() => focusRow(f)}
                  onFocusCapture={() => focusRow(f)}
                >
                  <td className="fb-list-cell-name">
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

                  <td>
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

                  <td>
                    {stage ? (
                      <PositionInput
                        value={f.stageOrder ?? null}
                        max={Math.max(1, existingStages.length)}
                        label={`Order of stage ${stage}`}
                        title={`Moves the whole “${stage}” stage in the completion order (1–${existingStages.length}).`}
                        disabled={!canEdit}
                        onCommit={(n) => onMoveStage(stage, n)}
                      />
                    ) : (
                      <span className="fb-list-dash" title="Unassigned fields have no stage order">
                        —
                      </span>
                    )}
                  </td>

                  <td>
                    <PositionInput
                      value={f.orderInGroup ?? null}
                      max={groupSize}
                      label={`Position of ${f.label || typeLabelOf(f.type)} in its list`}
                      title={`Position in ${stage ? `“${stage}”` : 'Unassigned'} (1–${groupSize}).`}
                      disabled={!canEdit}
                      onCommit={(n) => onMoveFieldInGroup(f.id, n)}
                    />
                  </td>

                  <td className="fb-list-cell-req">
                    <input
                      type="checkbox"
                      className="fb-list-check"
                      checked={f.required === true}
                      aria-label={`${f.label || typeLabelOf(f.type)} is required`}
                      disabled={!canEdit}
                      onChange={(e) => onUpdateField(f.id, { required: e.target.checked })}
                    />
                  </td>

                  <td className="fb-list-cell-page">{f.page || 1}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
