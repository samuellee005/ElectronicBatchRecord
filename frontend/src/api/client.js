/**
 * API client for PHP backend. All endpoints live under /includes/*.php
 * In dev, Vite proxies /includes, /uploads, /data, /forms to the PHP server.
 */

import { isViteAuthBypass } from '../authDev'

const API_BASE = ''

/**
 * Console debug for save / mark-complete flows. Enable one of:
 * - `localStorage.setItem('ebrDebug', '1')` then refresh
 * - `window.__EBR_DEBUG__ = true` in the devtools console
 * - `.env`: `VITE_EBR_DEBUG=1` (rebuild dev server)
 */
export function isEbrApiDebug() {
  try {
    if (import.meta.env?.VITE_EBR_DEBUG === '1') return true
  } catch {
    /* no vite */
  }
  if (typeof localStorage !== 'undefined' && localStorage.getItem('ebrDebug') === '1') return true
  if (typeof window !== 'undefined' && window.__EBR_DEBUG__) return true
  return false
}

function summarizeJsonForDebug(debugLabel, bodyStr) {
  try {
    const o = JSON.parse(bodyStr)
    if (debugLabel === 'save-data') {
      const keys = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? Object.keys(o.data) : []
      return {
        formId: o.formId,
        batchId: o.batchId ?? null,
        dataFieldCount: keys.length,
        dataFieldIdsSample: keys.slice(0, 16),
        stageCompletionLen: Array.isArray(o.stageCompletion) ? o.stageCompletion.length : 0,
        stagesLen: Array.isArray(o.stages) ? o.stages.length : 0,
        savedAt: o.savedAt,
      }
    }
    if (debugLabel === 'update-batch-record') {
      return {
        batchId: o.batchId,
        status: o.status,
        completedSignOffBy: o.completedSignOffBy,
        hasSignOffAt: !!o.completedSignOffAt,
      }
    }
    return { keys: Object.keys(o || {}) }
  } catch (e) {
    return { parseError: String(e) }
  }
}

async function request(path, options = {}) {
  const { debugLabel, ...fetchOpts } = options
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const bodyStr = fetchOpts.body

  if (debugLabel && isEbrApiDebug()) {
    const summary =
      typeof bodyStr === 'string' ? summarizeJsonForDebug(debugLabel, bodyStr) : { body: typeof bodyStr }
    console.debug(`[EBR API] ${debugLabel} request →`, path, summary)
  }

  const res = await fetch(url, {
    ...fetchOpts,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...fetchOpts.headers,
    },
  })
  const data = await res.json().catch(() => ({}))

  if (
    res.status === 401 &&
    data?.code === 'auth_required' &&
    typeof window !== 'undefined' &&
    !url.includes('auth-me.php') &&
    !url.includes('login.php') &&
    !isViteAuthBypass()
  ) {
    window.location.assign(`${window.location.origin}/login`)
  }

  if (debugLabel && isEbrApiDebug()) {
    const line = {
      httpStatus: res.status,
      ok: res.ok,
      success: data.success,
      message: data.message,
    }
    if (data.detail != null) line.detail = data.detail
    if (data.entryId) line.entryId = data.entryId
    if (data.filename) line.filename = data.filename
    if (data.batch && typeof data.batch === 'object') {
      line.batch = {
        id: data.batch.id,
        status: data.batch.status,
        completedAt: data.batch.completedAt,
        lastEntryId: data.batch.lastEntryId,
      }
    }
    if (data.debugInfo) line.serverDebug = data.debugInfo
    console.debug(`[EBR API] ${debugLabel} response ←`, line)
  }

  if (!res.ok) throw new Error(data.message || res.statusText || 'Request failed')
  return data
}

/** Current PHP session user (always 200; check authenticated). */
export async function authMe() {
  return request('/includes/auth-me.php')
}

/** Public: whether the server expects a password on login. */
export async function getLoginConfig() {
  return request('/includes/login-config.php')
}

export async function apiLogin(body) {
  return request('/includes/login.php', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function apiLogout() {
  return request('/includes/logout.php', { method: 'POST', body: '{}' })
}

// Forms
export async function listForms() {
  return request('/includes/list-forms.php')
}

export async function loadFormByPdf(pdf) {
  return request(`/includes/load-form.php?pdf=${encodeURIComponent(pdf)}`)
}

export async function loadFormById(id) {
  return request(`/includes/load-form-by-id.php?id=${encodeURIComponent(id)}`)
}

export async function saveForm(body) {
  return request('/includes/save-form.php', { method: 'POST', body: JSON.stringify(body) })
}

// Data entry & batch
export async function saveData(body) {
  return request('/includes/save-data.php', {
    method: 'POST',
    body: JSON.stringify(body),
    debugLabel: 'save-data',
  })
}

export async function createBatchRecord(body) {
  return request('/includes/create-batch-record.php', { method: 'POST', body: JSON.stringify(body) })
}

export async function listBatchRecords(status, createdBy) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (createdBy) params.set('createdBy', createdBy)
  const qs = params.toString()
  return request(`/includes/list-batch-records.php${qs ? `?${qs}` : ''}`)
}

export async function updateBatchRecord(body) {
  return request('/includes/update-batch-record.php', {
    method: 'POST',
    body: JSON.stringify(body),
    debugLabel: 'update-batch-record',
  })
}

/** Server-side UI preferences (PostgreSQL ebr_user_preferences), keyed by display name. */
export async function getUserPreferences(userKey) {
  const qs = userKey ? `?userKey=${encodeURIComponent(userKey)}` : ''
  return request(`/includes/get-user-preferences.php${qs}`)
}

export async function saveUserPreferences(body) {
  return request('/includes/save-user-preferences.php', { method: 'POST', body: JSON.stringify(body) })
}

export async function getBatchRecord(batchId) {
  return request(`/includes/get-batch-record.php?batchId=${encodeURIComponent(batchId)}`)
}

/** @param {{ q: string; scope?: 'both' | 'batch_title' | 'form_name' }} params */
export async function searchData(params) {
  const q = new URLSearchParams()
  q.set('q', params.q || '')
  q.set('scope', params.scope || 'both')
  return request(`/includes/search-data.php?${q.toString()}`)
}

/** Returns the URL to download a batch as PDF (saved server data; GET). */
export function getDownloadBatchPdfUrl(batchId) {
  return `/includes/download-batch-pdf.php?batchId=${encodeURIComponent(batchId)}`
}

/**
 * Generate PDF from current form data (POST). Use for preview / export before or without saving.
 * @param {{ formId: string, pdfFile: string, data: object, batch?: object }} body
 * @returns {Promise<Blob>}
 */
export async function exportBatchPdfBlob(body) {
  const res = await fetch(`${API_BASE}/includes/export-batch-pdf.php`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ct = res.headers.get('Content-Type') || ''
  if (ct.includes('application/json')) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.message || 'PDF export failed')
  }
  if (!res.ok) throw new Error('PDF export failed')
  return res.blob()
}

// Templates / PDFs
export async function listPdfs() {
  return request('/includes/list-pdfs.php')
}

export async function mergePdfs(pdfFiles) {
  return request('/includes/merge-pdfs.php', {
    method: 'POST',
    body: JSON.stringify({ pdfFiles }),
  })
}

export async function testGhostscript() {
  return request('/includes/test-ghostscript.php')
}

/** @returns {Promise<{ success: boolean, users: Array<{ id: string, displayName: string, active: boolean, role: 'admin'|'user' }> }>} */
export async function listActiveUsers(all = false) {
  const q = all ? '?all=1' : ''
  return request(`/includes/list-active-users.php${q}`)
}

export async function saveActiveUsers(users) {
  return request('/includes/save-active-users.php', {
    method: 'POST',
    body: JSON.stringify({ users }),
  })
}

/**
 * Upload template: multipart form to PHP. Use FormData, not JSON.
 * Backend expects: upload-template.php (form POST). We need an endpoint that accepts multipart.
 * If upload-template.php returns HTML, we may need a dedicated api/upload-template.php that returns JSON.
 */
export async function uploadTemplate(file) {
  const form = new FormData()
  form.append('pdf_file', file)
  const res = await fetch(`${API_BASE}/includes/upload-template-api.php`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.success) {
    throw new Error(data.message || res.statusText || 'Upload failed')
  }
  return data
}
