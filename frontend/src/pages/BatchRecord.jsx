import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listBatchRecords, listForms } from '../api/client'
import './BatchRecord.css'

const filterTitles = { 'in-progress': 'In Progress', 'completed': 'Completed', 'commonly-used': 'Commonly Used' }

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
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
    ? records.filter(
        (r) =>
          (r.title || '').toLowerCase().includes(searchLower) ||
          (r.description || '').toLowerCase().includes(searchLower) ||
          (r.formName || '').toLowerCase().includes(searchLower)
      )
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
        <input type="text" className="search-box" placeholder="Search by title, description, or form..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
      </div>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="batch-table-wrapper">
          <table className="batch-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Description</th>
                <th>Form</th>
                <th>Created</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>{r.title || '—'}</td>
                  <td>{r.description || '—'}</td>
                  <td>{r.formName || '—'}</td>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>{formatDate(r.updatedAt)}</td>
                  <td className="actions-cell">
                    <Link
                      to={`/forms/entry?form=${encodeURIComponent(r.formId)}&batch=${encodeURIComponent(r.id)}`}
                      className={status === 'in_progress' ? 'resume-link' : 'view-link'}
                    >
                      {status === 'in_progress' ? 'Resume' : 'View'}
                    </Link>
                    {r.pdfFile && r.formId && (
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
      )}
      {!loading && records.length === 0 && <div className="placeholder-box" style={{ marginTop: 16 }}><p>No batch records found.</p></div>}
    </div>
  )
}
