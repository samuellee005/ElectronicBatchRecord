/**
 * Human-readable lines for form configuration audit trail (see includes/save-form.php).
 */

const TYPE_LABELS = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  textarea: 'Text area',
  dropdown: 'Dropdown',
  checkbox: 'Checkbox',
  time: 'Time',
  radio: 'Radio group',
  multiselect: 'Multi select',
  collaborator: 'Collaborator',
  table: 'Data table',
  signature: 'Signature',
}

function humanFieldType(t) {
  if (t == null || t === '') return 'field'
  const k = String(t).toLowerCase()
  return TYPE_LABELS[k] || String(t)
}

function fmtPos(p) {
  if (!p || typeof p !== 'object') return '—'
  return `(${Math.round(Number(p.x) || 0)}, ${Math.round(Number(p.y) || 0)})`
}

function fmtSize(s) {
  if (!s || typeof s !== 'object') return '—'
  return `${Math.round(Number(s.width) || 0)} × ${Math.round(Number(s.height) || 0)} px`
}

function str(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * One line for a single change record from component_modified.
 * @param {{ field: string, old?: unknown, new?: unknown }} c
 */
export function describeAuditChange(c) {
  const f = c.field
  if (f === 'name') return `Label: ${str(c.old)} → ${str(c.new)}`
  if (f === 'position') return `Position: ${fmtPos(c.old)} → ${fmtPos(c.new)}`
  if (f === 'size') return `Size: ${fmtSize(c.old)} → ${fmtSize(c.new)}`
  if (f === 'type') return `Type: ${humanFieldType(c.old)} → ${humanFieldType(c.new)}`
  if (f === 'required') return `Required: ${str(c.old)} → ${str(c.new)}`
  if (f === 'stageInProcess') return `Stage: ${str(c.old)} → ${str(c.new)}`
  if (f === 'stageOrder') return `Stage order: ${str(c.old)} → ${str(c.new)}`
  if (f === 'page') return `Page: ${str(c.old)} → ${str(c.new)}`
  return `${f}: ${str(c.old)} → ${str(c.new)}`
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {{ headline: string, bodyLines: string[], meta: string }}
 */
export function formatAuditEntryBlock(entry) {
  const user = entry.user || 'Unknown'
  const ts =
    entry.timestamp && !Number.isNaN(Date.parse(String(entry.timestamp)))
      ? new Date(String(entry.timestamp)).toLocaleString()
      : '—'
  const meta = `${user} · ${ts}`

  const type = String(entry.type || '')

  if (type === 'component_added') {
    const label = entry.componentName || 'Unnamed'
    const typ = humanFieldType(entry.componentType)
    const lines = []
    const d = entry.details
    if (d && typeof d === 'object') {
      if (d.position) lines.push(`Placed at ${fmtPos(d.position)}`)
      if (d.size) lines.push(`Initial size ${fmtSize(d.size)}`)
    }
    return {
      headline: `Added field: "${label}" (${typ})`,
      bodyLines: lines,
      meta,
    }
  }

  if (type === 'component_removed') {
    const label = entry.componentName || 'Unnamed'
    const typ = humanFieldType(entry.componentType)
    return {
      headline: `Removed field: "${label}" (${typ})`,
      bodyLines: [],
      meta,
    }
  }

  if (type === 'component_modified') {
    const label = entry.componentName || 'Unnamed'
    const typ = humanFieldType(entry.componentType)
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    const bodyLines = changes.map((c) => (c && typeof c === 'object' ? describeAuditChange(c) : String(c)))
    return {
      headline: `Updated field: "${label}" (${typ})`,
      bodyLines,
      meta,
    }
  }

  if (type === 'pdf_changed') {
    return {
      headline: 'PDF template replaced',
      bodyLines: [
        `Previous: ${entry.oldPdf || '—'}`,
        `New: ${entry.newPdf || '—'}`,
        entry.versionChange ? `Version: ${entry.versionChange}` : '',
      ].filter(Boolean),
      meta,
    }
  }

  if (type === 'version_updated') {
    return {
      headline: `Form version saved (${entry.oldVersion || '?'} → ${entry.newVersion || '?'})`,
      bodyLines: entry.reason ? [String(entry.reason)] : [],
      meta,
    }
  }

  return {
    headline: type ? `Event: ${type}` : 'Event',
    bodyLines: [],
    meta,
  }
}
