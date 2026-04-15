import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listBatchRecords, listForms, getDownloadBatchPdfUrl } from '../api/client'
import './BatchRecord.css'

const filterTitles = { 'in-progress': 'In Progress', 'completed': 'Completed', 'commonly-used': 'Commonly Used' }

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

/** Short date/time for batch list table (fits fixed-width columns on one line). */
function formatBatchTableDate(d) {
  if (!d) return '—'
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getFavorites() {
  try { return JSON.parse(localStorage.getItem('ebrFavorites') || '[]') } catch { return [] }
}

function getRecentlyUsed() {
  try { return JSON.parse(localStorage.getItem('ebrRecentlyUsed') || '[]') } catch { return [] }
}

export default function BatchRecord() {
  const [searchParams] = useSearchParams()
  const filter = searchParams.get('filter') || 'in-progress'
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [forms, setForms] = useState([])
  const [commonlyUsedLoading, setCommonlyUsedLoading] = useState(false)
  const [searchFav, setSearchFav] = useState('')
  const [searchRecent, setSearchRecent] = useState('')
  /** Which batch row has the Actions menu open (`record.id`). */
  const [openActionsId, setOpenActionsId] = useState(null)
  const actionsMenuRef = useRef(null)

  const status = filter === 'completed' ? 'completed' : 'in_progress'
  const isCommonlyUsed = filter === 'commonly-used'

  useEffect(() => {
    if (isCommonlyUsed) {
      setCommonlyUsedLoading(true)
      listForms().then((res) => setForms(res.forms || [])).finally(() => setCommonlyUsedLoading(false))
      return
    }
    setLoading(true)
    listBatchRecords(status).then((res) => setRecords(res.records || [])).finally(() => setLoading(false))
  }, [filter, status, isCommonlyUsed])

  useEffect(() => {
    if (openActionsId == null) return
    const onDocMouseDown = (e) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target)) {
        setOpenActionsId(null)
      }
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpenActionsId(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openActionsId])

  const toggleActionsMenu = useCallback((recordId) => {
    setOpenActionsId((prev) => (prev === recordId ? null : recordId))
  }, [])

  const favorites = getFavorites()
  const favForms = forms.filter((f) => favorites.includes(f.id))
  const recentlyUsed = getRecentlyUsed()

  const searchFavLower = searchFav.trim().toLowerCase()
  const filteredFav = searchFavLower
    ? favForms.filter(
        (f) =>
          (f.name || '').toLowerCase().includes(searchFavLower) ||
          (f.pdfFile || '').toLowerCase().includes(searchFavLower)
      )
    : favForms

  const searchRecentLower = searchRecent.trim().toLowerCase()
  const filteredRecent = searchRecentLower
    ? recentlyUsed.filter((r) => (r.formName || '').toLowerCase().includes(searchRecentLower))
    : recentlyUsed

  const searchLower = search.trim().toLowerCase()
  const filtered = searchLower
    ? records.filter((r) => {
        const num = String(r.batchId ?? r.id ?? '').toLowerCase()
        return (
          num.includes(searchLower) ||
          (r.title || '').toLowerCase().includes(searchLower) ||
          (r.description || '').toLowerCase().includes(searchLower) ||
          (r.formName || '').toLowerCase().includes(searchLower)
        )
      })
    : records

  if (isCommonlyUsed) {
    return (
      <div className="page-content">
        <h1 className="page-title">Batch Record</h1>
        <p className="page-subtitle">{filterTitles[filter]}</p>

        <section className="commonly-used-section">
          <h2 className="commonly-used-heading">Favorites</h2>
          <div className="table-toolbar">
            <input
              type="text"
              className="search-box"
              placeholder="Search favorites by form name or PDF..."
              value={searchFav}
              onChange={(e) => setSearchFav(e.target.value)}
              aria-label="Search favorites"
            />
          </div>
          {commonlyUsedLoading ? (
            <p>Loading…</p>
          ) : filteredFav.length > 0 ? (
            <div className="batch-table-wrapper">
              <table className="batch-table">
                <thead>
                  <tr>
                    <th>Form name</th>
                    <th>PDF</th>
                    <th>Version</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFav.map((f) => (
                    <tr key={f.id}>
                      <td>{f.name || '—'}</td>
                      <td><code>{f.pdfFile || '—'}</code></td>
                      <td>v{f.version ?? 1}{f.isLatest ? ' (latest)' : ''}</td>
                      <td className="actions-cell">
                        <Link to={`/forms/entry?form=${encodeURIComponent(f.id)}`} className="resume-link">Use</Link>
                        {f.pdfFile && (
                          <Link to={`/forms/builder?file=${encodeURIComponent(f.pdfFile)}&formId=${encodeURIComponent(f.id)}`} className="view-form-link">
                            View form
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="placeholder-box" style={{ marginTop: 0 }}>
              <p>{favForms.length === 0 ? 'No favorites yet. Star forms on Batch Record Forms to add them here.' : 'No favorites match your search.'}</p>
              {favForms.length === 0 && <p><Link to="/forms">Go to Batch Record Forms</Link></p>}
            </div>
          )}
        </section>

        <section className="commonly-used-section">
          <h2 className="commonly-used-heading">Recently used</h2>
          <div className="table-toolbar">
            <input
              type="text"
              className="search-box"
              placeholder="Search recently used by form name..."
              value={searchRecent}
              onChange={(e) => setSearchRecent(e.target.value)}
              aria-label="Search recently used"
            />
          </div>
          {filteredRecent.length > 0 ? (
            <div className="batch-table-wrapper">
              <table className="batch-table">
                <thead>
                  <tr>
                    <th>Form name</th>
                    <th>Last used</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecent.map((r, idx) => (
                    <tr key={r.formId + (r.openedAt || '') + idx}>
                      <td>{r.formName || '—'}</td>
                      <td>{formatDate(r.openedAt)}</td>
                      <td className="actions-cell">
                        <Link to={`/forms/entry?form=${encodeURIComponent(r.formId)}`} className="resume-link">Use</Link>
                        {r.pdfFile && (
                          <Link to={`/forms/builder?file=${encodeURIComponent(r.pdfFile)}&formId=${encodeURIComponent(r.formId)}`} className="view-form-link">
                            View form
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="placeholder-box" style={{ marginTop: 0 }}>
              <p>{recentlyUsed.length === 0 ? 'No recently used forms yet. Open a form from Batch Record Forms to see it here.' : 'No recently used forms match your search.'}</p>
              {recentlyUsed.length === 0 && <p><Link to="/forms">Go to Batch Record Forms</Link></p>}
            </div>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="page-content">
      <h1 className="page-title">Batch Record</h1>
      <p className="page-subtitle">{filterTitles[filter]}</p>
      <div className="table-toolbar">
        <input
          type="text"
          className="search-box"
          placeholder="Search by batch number, title, description, or form…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search"
        />
      </div>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="batch-table-wrapper batch-table-wrapper--records">
          <table className="batch-table batch-table--records" data-batch-status={status}>
            <thead>
              <tr>
                <th className="batch-table-col batch-table-col--batch-num" scope="col">Batch number</th>
                <th className="batch-table-col batch-table-col--title" scope="col">Title</th>
                <th className="batch-table-col batch-table-col--description" scope="col">Description</th>
                <th className="batch-table-col batch-table-col--form" scope="col">Form</th>
                <th className="batch-table-col batch-table-col--date" scope="col">Created</th>
                <th className="batch-table-col batch-table-col--date" scope="col">Updated</th>
                <th className="batch-table-col batch-table-col--actions" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const bid = r.batchId ?? r.id
                const entryTo = `/forms/entry?form=${encodeURIComponent(r.formId)}&batch=${encodeURIComponent(bid)}`
                const menuOpen = openActionsId === r.id
                return (
                <tr key={r.id}>
                  <td className="batch-table-col batch-table-col--batch-num">
                    {bid ? (
                      <Link
                        to={entryTo}
                        className="batch-table-batch-number batch-table-batch-link"
                        title={`Open batch ${bid}`}
                      >
                        {bid}
                      </Link>
                    ) : (
                      <span className="batch-table-batch-number">—</span>
                    )}
                  </td>
                  <td className="batch-table-col batch-table-col--title">
                    <span className="batch-table-ellipsis" title={r.title || ''}>{r.title || '—'}</span>
                  </td>
                  <td className="batch-table-col batch-table-col--description">
                    <span className="batch-table-ellipsis" title={r.description || ''}>{r.description || '—'}</span>
                  </td>
                  <td className="batch-table-col batch-table-col--form">
                    <span className="batch-table-ellipsis" title={r.formName || ''}>{r.formName || '—'}</span>
                  </td>
                  <td className="batch-table-col batch-table-col--date">
                    <span className="batch-table-date" title={formatDate(r.createdAt)}>{formatBatchTableDate(r.createdAt)}</span>
                  </td>
                  <td className="batch-table-col batch-table-col--date">
                    <span className="batch-table-date" title={formatDate(r.updatedAt)}>{formatBatchTableDate(r.updatedAt)}</span>
                  </td>
                  <td className="batch-table-col batch-table-col--actions actions-cell">
                    <div
                      className="batch-table-actions-menu"
                      ref={menuOpen ? actionsMenuRef : null}
                    >
                      <button
                        type="button"
                        className="batch-table-actions-trigger"
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        aria-controls={`batch-actions-${r.id}`}
                        id={`batch-actions-btn-${r.id}`}
                        onClick={() => toggleActionsMenu(r.id)}
                      >
                        Actions
                      </button>
                      {menuOpen && (
                        <ul
                          className="batch-table-actions-dropdown"
                          id={`batch-actions-${r.id}`}
                          role="menu"
                          aria-labelledby={`batch-actions-btn-${r.id}`}
                        >
                          <li role="none">
                            <Link
                              role="menuitem"
                              to={entryTo}
                              className="batch-table-actions-item batch-table-actions-item--primary"
                              onClick={() => setOpenActionsId(null)}
                            >
                              {status === 'in_progress' ? 'Resume' : 'View'}
                            </Link>
                          </li>
                          {r.pdfFile && r.formId && (
                            <li role="none">
                              <Link
                                role="menuitem"
                                to={`/forms/builder?file=${encodeURIComponent(r.pdfFile)}&formId=${encodeURIComponent(r.formId)}`}
                                className="batch-table-actions-item"
                                onClick={() => setOpenActionsId(null)}
                              >
                                View form
                              </Link>
                            </li>
                          )}
                          {status === 'completed' && bid && (
                            <li role="none">
                              <a
                                role="menuitem"
                                href={getDownloadBatchPdfUrl(bid)}
                                className="batch-table-actions-item"
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setOpenActionsId(null)}
                              >
                                Download PDF
                              </a>
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && records.length === 0 && <div className="placeholder-box" style={{ marginTop: 16 }}><p>No batch records found.</p></div>}
    </div>
  )
}
