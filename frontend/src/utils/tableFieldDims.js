/**
 * Column / row size interpretation for data-table fields. Shared by FormBuilder and DataEntry
 * so overlay grid math matches the canvas preview. Uses parseInt like FormBuilder resize logic.
 */
export const DEFAULT_TABLE_COL_WIDTH = 72
export const DEFAULT_TABLE_ROW_HEIGHT = 28

export function tableColWidthPx(c) {
  const w = parseInt(c?.width, 10)
  return Number.isFinite(w) && w >= 12 ? w : DEFAULT_TABLE_COL_WIDTH
}

export function tableRowHeightPx(r) {
  const h = parseInt(r?.height, 10)
  return Number.isFinite(h) && h >= 12 ? h : DEFAULT_TABLE_ROW_HEIGHT
}
