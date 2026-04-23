/**
 * Two-letter initials for avatar display from session user.
 * @param {{ displayName?: string, username?: string } | null | undefined} user
 * @returns {string}
 */
export function getUserInitials(user) {
  if (!user) return '?'
  const name = String(user.displayName || user.username || '').trim()
  if (!name) return '?'
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0][0] || ''
    const b = parts[parts.length - 1][0] || ''
    return (a + b).toUpperCase() || '?'
  }
  const w = parts[0] || name
  if (w.length >= 2) return (w[0] + w[1]).toUpperCase()
  return (w[0] || '?').toUpperCase()
}
