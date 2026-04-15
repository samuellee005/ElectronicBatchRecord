/**
 * Shared table merge layout for Form Builder preview and Data Entry overlay.
 * Merges use anchor row/column + rowspan/colspan; see FormBuilder TableFieldProperties.
 */

const TABLE_KEY_SEP = '::'

export function tableCellKey(rowId, colId) {
  return `${rowId}${TABLE_KEY_SEP}${colId}`
}

/**
 * @returns {{ rowIds: string[], colIds: string[], covered: Set<string>, spanOf: Map<string, { rowspan: number, colspan: number }> }}
 */
export function buildTableMergeLayout(field) {
  const rowIds = (field.tableRows || []).map((r) => r.id)
  const colIds = (field.tableColumns || []).map((c) => c.id)
  const covered = new Set()
  const spanOf = new Map()

  for (const m of field.tableMerges || []) {
    const ri = rowIds.indexOf(m.anchorRowId)
    const ci = colIds.indexOf(m.anchorColId)
    const rs = Math.max(1, parseInt(m.rowspan, 10) || 1)
    const cs = Math.max(1, parseInt(m.colspan, 10) || 1)
    if (ri < 0 || ci < 0) continue
    if (ri + rs > rowIds.length || ci + cs > colIds.length) continue
    const anchorKey = tableCellKey(rowIds[ri], colIds[ci])
    spanOf.set(anchorKey, { rowspan: rs, colspan: cs })
    for (let dr = 0; dr < rs; dr++) {
      for (let dc = 0; dc < cs; dc++) {
        if (dr === 0 && dc === 0) continue
        const rk = rowIds[ri + dr]
        const ck = colIds[ci + dc]
        if (rk && ck) covered.add(tableCellKey(rk, ck))
      }
    }
  }
  return { rowIds, colIds, covered, spanOf }
}
