import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { searchData } from '../api/client'
import './DataSearch.css'

function buildExcelFilename(query) {
  const safe = (query || 'export').slice(0, 48).replace(/[^\w\s-]/g, '').replace(/\s+/g, '_') || 'export'
  return `data-search_${safe}_${new Date().toISOString().slice(0, 10)}.xlsx`
}

function downloadSearchResultsExcel(results, columns, query) {
  if (!results.length) return
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const headers = ['Batch title', 'Form', 'Status', ...columns, 'Batch ID', 'Open link']
  const dataRows = results.map((row) => {
    const openUrl = `${origin}/forms/entry?form=${encodeURIComponent(row.formId)}&batch=${encodeURIComponent(row.batchId)}`
    return [
      row.title ?? '',
      row.formName ?? '',
      row.status === 'completed' ? 'Completed' : 'In progress',
      ...columns.map((col) => {
        const v = row.fieldValues?.[col]
        return v != null && String(v).trim() !== '' ? String(v) : ''
      }),
      row.batchId ?? '',
      openUrl,
    ]
  })
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Results')
  XLSX.writeFile(wb, buildExcelFilename(query))
}

const SCOPES = [
  { value: 'both', label: 'Batch title or form name' },
  { value: 'batch_title', label: 'Batch title only' },
  { value: 'form_name', label: 'Form name only' },
]

export default function DataSearch() {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('both')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState([])
  const [columns, setColumns] = useState([])
  const [searched, setSearched] = useState(false)

  const runSearch = useCallback(
    async (e) => {
      e?.preventDefault()
      const q = query.trim()
      if (!q) {
        setError('Enter a search term.')
        setResults([])
        setColumns([])
        setSearched(true)
        return
      }
      setLoading(true)
      setError(null)
      setSearched(true)
      try {
        const res = await searchData({ q, scope })
        if (!res.success) throw new Error(res.message || 'Search failed')
        setResults(res.results || [])
        setColumns(res.columns || [])
      } catch (err) {
        setError(err.message || 'Search failed')
        setResults([])
        setColumns([])
      } finally {
        setLoading(false)
      }
    },
    [query, scope],
  )

  const fixedCols = [
    { key: 'title', label: 'Batch title' },
    { key: 'formName', label: 'Form' },
    { key: 'status', label: 'Status' },
  ]

  return (
    <div className="page-content data-search-page">
      <h1 className="page-title">Data Search</h1>
      <p className="data-search-intro">
        Search batch records by title or form name. Matching rows show all form fields; shared field labels align in the same column. Different forms add
        columns as needed.
      </p>

      <form className="data-search-form" onSubmit={runSearch}>
        <div className="data-search-row">
          <label className="sr-only" htmlFor="data-search-q">
            Search
          </label>
          <input
            id="data-search-q"
            type="search"
            className="data-search-input"
            placeholder="e.g. batch title or form name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <select className="data-search-scope" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Search in">
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primary data-search-submit" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {error && <div className="data-search-error">{error}</div>}

      {searched && !loading && !error && results.length === 0 && query.trim() && (
        <div className="data-search-empty">No batch records matched your search.</div>
      )}

      {results.length > 0 && (
        <div className="data-search-export-row">
          <button
            type="button"
            className="btn btn-primary data-search-export-btn"
            onClick={() => downloadSearchResultsExcel(results, columns, query.trim())}
          >
            Download as Excel (.xlsx)
          </button>
        </div>
      )}

      {results.length > 0 && (
        <div className="data-search-table-wrap">
          <table className="data-search-table">
            <thead>
              <tr>
                {fixedCols.map((c) => (
                  <th key={c.key} className="data-search-th-fixed">
                    {c.label}
                  </th>
                ))}
                {columns.map((col) => (
                  <th key={col} className="data-search-th-dynamic" title={col}>
                    {col}
                  </th>
                ))}
                <th className="data-search-th-fixed data-search-th-narrow">Open</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.batchId}>
                  <td className="data-search-td-fixed">{row.title || '—'}</td>
                  <td className="data-search-td-fixed">{row.formName || '—'}</td>
                  <td className="data-search-td-fixed">
                    <span className={'data-search-status data-search-status-' + (row.status === 'completed' ? 'done' : 'open')}>
                      {row.status === 'completed' ? 'Completed' : 'In progress'}
                    </span>
                  </td>
                  {columns.map((col) => {
                    const v = row.fieldValues?.[col]
                    const show = v != null && String(v).trim() !== ''
                    return (
                      <td key={col} className="data-search-td-dynamic" title={show ? String(v) : ''}>
                        {show ? v : '—'}
                      </td>
                    )
                  })}
                  <td className="data-search-td-fixed data-search-td-narrow">
                    <Link to={`/forms/entry?form=${encodeURIComponent(row.formId)}&batch=${encodeURIComponent(row.batchId)}`} className="data-search-open-link">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results.length > 0 && (
        <p className="data-search-footnote">{results.length} record(s). A richer table component can replace this layout later.</p>
      )}
    </div>
  )
}
