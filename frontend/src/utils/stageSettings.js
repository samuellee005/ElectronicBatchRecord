/**
 * Stage-level settings, stored per field and kept in step across every field
 * in a stage — the same pattern `stageOrder` uses. Keeping them on the fields
 * means undo/redo, stage rename/merge, field import and saving need nothing
 * extra.
 *
 * `stageRequired`: the stage must be completed (its Required fields submitted)
 * before later stages open. Forms saved before this setting existed have no
 * value, which reads as required — that was the only behavior then.
 */

function stageNameOf(field) {
  return String(field?.stageInProcess || '').trim()
}

/** Whether a stage (given its fields) blocks later stages until it is done. */
export function isStageGate(stageFields) {
  const list = stageFields || []
  if (list.length === 0) return false
  return !list.every((f) => f.stageRequired === false)
}

/**
 * `stageRequired` for a field joining `stageName`: the stage's current setting
 * when it already exists, otherwise `false` — new stages start optional.
 * `excludeFieldId` skips the moving field itself.
 */
export function stageRequiredForJoin(fields, stageName, excludeFieldId) {
  const sn = String(stageName || '').trim()
  if (!sn) return undefined
  const peers = (fields || []).filter((f) => f.id !== excludeFieldId && stageNameOf(f) === sn)
  if (peers.length === 0) return false
  return isStageGate(peers)
}
