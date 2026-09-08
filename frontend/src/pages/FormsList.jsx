import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { StarIcon } from '@heroicons/react/24/solid'
import { listForms } from '../api/client'
import { useUserPrefs } from '../context/UserPrefsContext'
import './FormsList.css'

/** Dropdown of checkboxes for filtering by one category; multiple values allowed. */
function MultiSelectFilter({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const toggle = (v) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <div className="forms-filter" ref={ref}>
      <button
        type="button"
        className={`forms-filter-btn${selected.length ? ' has-selection' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}{selected.length ? ` (${selected.length})` : ''}
        <span className="forms-filter-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="forms-filter-menu" role="group" aria-label={label}>
          {options.length === 0 ? (
            <p className="forms-filter-empty">None yet</p>
          ) : (
            <>
              {options.map((v) => (
                <label key={v} className="forms-filter-item">
                  <input type="checkbox" checked={selected.includes(v)} onChange={() => toggle(v)} />
                  <span>{v}</span>
                </label>
              ))}
              {selected.length > 0 && (
                <button type="button" className="forms-filter-clear" onClick={() => onChange([])}>
                  Clear
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function FormsList() {
  const { prefs, updatePrefs } = useUserPrefs()
  const [data, setData] = useState({ forms: [], groupedForms: {} })
  const [loading, setLoading] = useState(true)
  const [latestOnly, setLatestOnly] = useState(true)
  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState([])
  const [progFilter, setProgFilter] = useState([])
  const [typeFilter, setTypeFilter] = useState([])
  const favorites = useMemo(
    () => (Array.isArray(prefs.ebrFavorites) ? prefs.ebrFavorites : []),
    [prefs.ebrFavorites],
  )

  useEffect(() => {
    listForms().then((res) => setData({ forms: res.forms || [], groupedForms: res.groupedForms || {} })).finally(() => setLoading(false))
  }, [])

  const distinctValues = (key) =>
    [...new Set((data.forms || []).map((f) => (f[key] || '').trim()).filter(Boolean))].sort()
  const deptOptions = useMemo(() => distinctValues('department'), [data.forms])
  const progOptions = useMemo(() => distinctValues('program'), [data.forms])
  const typeOptions = useMemo(() => distinctValues('formType'), [data.forms])

  const forms = latestOnly ? (data.forms || []).filter((f) => f.isLatest) : (data.forms || [])
  const q = search.trim().toLowerCase()
  const filtered = forms.filter((f) => {
    if (q && !((f.name || '').toLowerCase().includes(q) || (f.pdfFile || '').toLowerCase().includes(q)))
      return false
    if (deptFilter.length && !deptFilter.includes((f.department || '').trim())) return false
    if (progFilter.length && !progFilter.includes((f.program || '').trim())) return false
    if (typeFilter.length && !typeFilter.includes((f.formType || '').trim())) return false
    return true
  })

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
        <div className="forms-filters">
          <MultiSelectFilter label="Department" options={deptOptions} selected={deptFilter} onChange={setDeptFilter} />
          <MultiSelectFilter label="Program" options={progOptions} selected={progFilter} onChange={setProgFilter} />
          <MultiSelectFilter label="Form type" options={typeOptions} selected={typeFilter} onChange={setTypeFilter} />
        </div>
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
                <td>
                  {form.name}
                  {(form.department || form.program || form.formType) && (
                    <div className="forms-row-meta">
                      {[form.department, form.program, form.formType]
                        .map((s) => (s || '').trim())
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </td>
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
