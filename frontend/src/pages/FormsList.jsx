import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { StarIcon } from '@heroicons/react/24/solid'
import { listForms } from '../api/client'
import { useUserPrefs } from '../context/UserPrefsContext'
import './FormsList.css'

export default function FormsList() {
  const { prefs, updatePrefs } = useUserPrefs()
  const [data, setData] = useState({ forms: [], groupedForms: {} })
  const [loading, setLoading] = useState(true)
  const [latestOnly, setLatestOnly] = useState(true)
  const [search, setSearch] = useState('')
  const favorites = useMemo(
    () => (Array.isArray(prefs.ebrFavorites) ? prefs.ebrFavorites : []),
    [prefs.ebrFavorites],
  )

  useEffect(() => {
    listForms().then((res) => setData({ forms: res.forms || [], groupedForms: res.groupedForms || {} })).finally(() => setLoading(false))
  }, [])

  const forms = latestOnly ? (data.forms || []).filter((f) => f.isLatest) : (data.forms || [])
  const q = search.trim().toLowerCase()
  const filtered = q ? forms.filter((f) => (f.name || '').toLowerCase().includes(q) || (f.pdfFile || '').toLowerCase().includes(q)) : forms

  const toggleFav = (id) => {
    const next = favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id]
    updatePrefs({ ebrFavorites: next })
  }

  if (loading) return <div className="page-content"><h1 className="page-title">Batch Record Forms</h1><p>Loading...</p></div>

  return (
    <div className="page-content forms-list-page">
      <h1 className="page-title">Batch Record Forms</h1>
      <div className="table-toolbar">
        <div className="view-toggle">
          <button type="button" className={latestOnly ? 'active' : ''} onClick={() => setLatestOnly(true)}>Latest only</button>
          <button type="button" className={!latestOnly ? 'active' : ''} onClick={() => setLatestOnly(false)}>All versions</button>
        </div>
        <input type="text" className="search-box" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="forms-table-wrapper">
        <table className="forms-table">
          <thead>
            <tr>
              <th>Favorite</th>
              <th>Form name</th>
              <th>Version</th>
              <th>PDF</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((form) => (
              <tr key={form.id}>
                <td>
                  <button type="button" className={'btn-fav ' + (favorites.includes(form.id) ? 'is-fav' : '')} onClick={() => toggleFav(form.id)} title={favorites.includes(form.id) ? 'Remove from favorites' : 'Add to favorites'}>
                    <StarIcon className="star-svg" />
                  </button>
                </td>
                <td>{form.name}</td>
                <td>v{form.version ?? 1}{form.isLatest ? ' LATEST' : ''}</td>
                <td><code>{form.pdfFile}</code></td>
                <td className="actions-cell">
                  <Link to={'/forms/entry?form=' + encodeURIComponent(form.id)} className="use-link">Use</Link>
                  {form.pdfFile && (
                    <Link to={`/forms/builder?file=${encodeURIComponent(form.pdfFile)}&formId=${encodeURIComponent(form.id)}`} className="view-form-link">
                      View form
                    </Link>
                  )}
                  <Link to={`/forms/audit?form=${encodeURIComponent(form.id)}`} className="audit-btn">
                    Audit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.forms && data.forms.length === 0 && <div className="empty-state"><p>No forms yet. <Link to="/forms/build">Build Form</Link></p></div>}
    </div>
  )
}
