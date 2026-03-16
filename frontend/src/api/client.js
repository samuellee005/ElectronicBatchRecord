/**
 * API client for PHP backend. All endpoints live under /includes/*.php
 * In dev, Vite proxies /includes, /uploads, /data, /forms to the PHP server.
 */

const API_BASE = ''

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || res.statusText || 'Request failed')
  return data
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
  return request('/includes/save-data.php', { method: 'POST', body: JSON.stringify(body) })
}

export async function createBatchRecord(body) {
  return request('/includes/create-batch-record.php', { method: 'POST', body: JSON.stringify(body) })
}

export async function listBatchRecords(status) {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/includes/list-batch-records.php${q}`)
}

export async function updateBatchRecord(body) {
  return request('/includes/update-batch-record.php', { method: 'POST', body: JSON.stringify(body) })
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
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!data.success) throw new Error(data.message || 'Upload failed')
  return data
}
