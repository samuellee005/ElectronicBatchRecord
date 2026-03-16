import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { listForms } from '../api/client'
import './Dashboard.css'

const STORAGE_FAVORITES = 'ebrFavorites'
const STORAGE_USER = 'ebrUserDisplayName'
const STORAGE_LAST_SEEN = 'ebrFormLastSeen'
const STORAGE_RESOLVED = 'ebrFavoriteResolved'

function getFavorites() {
  try {
    const s = localStorage.getItem(STORAGE_FAVORITES)
    return s ? JSON.parse(s) : []
  } catch { return [] }
}
function setFavorites(ids) {
  try { localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(ids)) } catch {}
}
function getUserName() {
  try { return localStorage.getItem(STORAGE_USER) || '' } catch { return '' }
}
function setUserName(name) {
  try { localStorage.setItem(STORAGE_USER, (name || '').trim()) } catch {}
}
function getLastSeen() {
  try {
    const s = localStorage.getItem(STORAGE_LAST_SEEN)
    return s ? JSON.parse(s) : {}
  } catch { return {} }
}
function getResolved() {
  try {
    const s = localStorage.getItem(STORAGE_RESOLVED)
    return s ? JSON.parse(s) : {}
  } catch { return {} }
}
function setResolved(obj) {
  try { localStorage.setItem(STORAGE_RESOLVED, JSON.stringify(obj)) } catch {}
}

function buildLatestByKey(groupedForms) {
  const latestByKey = {}
  Object.keys(groupedForms || {}).forEach((k) => {
    const group = groupedForms[k]
    if (!group || !group.length) return
    const latest = group[0]
    const key = (latest.name || '') + '|' + (latest.pdfFile || '')
    latestByKey[key] = latest
  })
  return latestByKey
}

export default function Dashboard() {
  const [forms, setForms] = useState([])
  const [groupedForms, setGroupedForms] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [userName, setUserNameState] = useState(getUserName())
  const [nameInput, setNameInput] = useState('')
  const [favPopover, setFavPopover] = useState(null)
  const [favorites, setFavoritesState] = useState(() => getFavorites())
  const [removeConfirmForm, setRemoveConfirmForm] = useState(null)

  useEffect(() => {
    listForms()
      .then((data) => {
        setForms(data.forms || [])
        setGroupedForms(data.groupedForms || {})
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const favForms = forms.filter((f) => favorites.includes(f.id))
  const latestByKey = buildLatestByKey(groupedForms)
  const resolved = getResolved()
  const lastSeen = getLastSeen()
  const myForms = userName ? forms.filter((f) => (f.createdBy || '').trim() === userName) : []
  myForms.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))

  const reminders = []
  Object.keys(groupedForms || {}).forEach((k) => {
    const group = groupedForms[k]
    if (!group || !group.length) return
    const latest = group[0]
    const groupKey = (latest.name || '') + '|' + (latest.pdfFile || '')
    const lastVersion = lastSeen[groupKey] || 0
    const curVersion = latest.version || 1
    if (curVersion > lastVersion) {
      reminders.push({
        name: latest.name,
        pdf: latest.pdfFile,
        version: curVersion,
        formId: latest.id,
        key: groupKey,
      })
    }
  })
  const favoritedKeys = {}
  forms.forEach((f) => {
    if (favorites.includes(f.id)) favoritedKeys[(f.name || '') + '|' + (f.pdfFile || '')] = true
  })

  const handleReplaceFav = (oldId, latestId, groupKey, latestVer) => {
    let favs = favorites.filter((id) => id !== oldId)
    if (!favs.includes(latestId)) favs.push(latestId)
    setFavorites(favs)
    setFavoritesState(favs)
    setResolved({ ...getResolved(), [groupKey]: latestVer })
    setFavPopover(null)
  }
  const handleDismissNewer = (groupKey, latestVer) => {
    setResolved({ ...getResolved(), [groupKey]: latestVer })
    setFavPopover(null)
  }
  const handleRemoveFav = (formId) => {
    const next = favorites.filter((id) => id !== formId)
    setFavorites(next)
    setFavoritesState(next)
    setRemoveConfirmForm(null)
  }
  const handleSaveName = () => {
    const name = nameInput.trim()
    if (name) {
      setUserName(name)
      setUserNameState(name)
    }
  }

  if (loading) return <div className="dashboard"><h1>Dashboard</h1><p>Loading…</p></div>
  if (error) return <div className="dashboard"><h1>Dashboard</h1><p className="error-message">Could not load forms: {error}</p></div>

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>
      <div className="widgets">
        <div className="widget">
          <div className="widget-header">★ Favorite forms</div>
          <div className="widget-body">
            {favForms.length === 0 ? (
              <p className="widget-empty">No favorites yet. Star forms on <Link to="/forms">Batch Record Forms</Link> to add them here.</p>
            ) : (
              <ul className="widget-list" id="favoritesList">
                {favForms.map((f) => {
                  const groupKey = (f.name || '') + '|' + (f.pdfFile || '')
                  const latest = latestByKey[groupKey]
                  const hasNewer = latest && latest.id !== f.id && (latest.version || 1) > (resolved[groupKey] || 0)
                  const popoverOpen = favPopover === f.id
                  return (
                    <li key={f.id}>
                      <div className="fav-item-wrap">
                        <span>{f.name}</span>
                        {hasNewer && (
                          <>
                            <span
                              className="fav-newer-badge"
                              title="A newer version is available"
                              onMouseEnter={() => setFavPopover(f.id)}
                              onClick={() => setFavPopover(popoverOpen ? null : f.id)}
                            >!</span>
                            {popoverOpen && (
                              <div className="fav-newer-popover show" onMouseLeave={() => setFavPopover(null)}>
                                <p>A newer version (v{latest.version || 1}) is available.</p>
                                <div className="fav-popover-actions">
                                  <button type="button" className="btn-replace" onClick={() => handleReplaceFav(f.id, latest.id, groupKey, latest.version || 1)}>Replace with new version</button>
                                  <button type="button" className="btn-dismiss" onClick={() => handleDismissNewer(groupKey, latest.version || 1)}>Dismiss</button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="fav-item-actions">
                        <button type="button" className="btn-remove-fav" title="Remove" onClick={() => setRemoveConfirmForm(f)} aria-label="Remove">
                          <XMarkIcon className="btn-remove-fav-icon" />
                        </button>
                        <Link to={`/forms/entry?form=${encodeURIComponent(f.id)}`} className="btn-use">Use</Link>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="widget">
          <div className="widget-header">📋 Forms you have built</div>
          <div className="widget-body">
            {!userName ? (
              <>
                <p className="widget-empty">Set your name to see forms you have built.</p>
                <input type="text" className="widget-name-input" placeholder="Your name" maxLength={100} value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
                <br />
                <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={handleSaveName}>Save name</button>
              </>
            ) : myForms.length === 0 ? (
              <p className="widget-empty">No forms built by you yet. Build forms from <Link to="/templates">Templates</Link>.</p>
            ) : (
              <>
                <ul className="widget-list">
                  {myForms.slice(0, 10).map((f) => (
                    <li key={f.id}>
                      <span>{f.name} (v{f.version ?? 1})</span>
                      <Link to={`/forms/entry?form=${encodeURIComponent(f.id)}`} className="btn-use">Use</Link>
                    </li>
                  ))}
                </ul>
                {myForms.length > 10 && <p className="widget-empty" style={{ marginTop: 8 }}><Link to="/forms">View all</Link></p>}
              </>
            )}
          </div>
        </div>

        <div className="widget">
          <div className="widget-header">🔔 Reminders</div>
          <div className="widget-body">
            {reminders.length === 0 ? (
              <p className="widget-empty">No new updates. Forms you use will show here when a new version is available.</p>
            ) : (
              reminders.map((r) => (
                <div key={r.key} className="reminder-item">
                  <strong>{r.name}</strong>
                  <span className="reminder-badge">New v{r.version}</span>
                  {favoritedKeys[r.key] && <span className="reminder-fav-badge" title="This form is in your favorites">!</span>}
                  <p>A new version of this form is available.</p>
                  <Link to={`/forms/entry?form=${encodeURIComponent(r.formId)}`}>Use new version</Link>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {removeConfirmForm && (
        <div className="fav-remove-modal-backdrop" onClick={() => setRemoveConfirmForm(null)}>
          <div className="fav-remove-modal" onClick={(e) => e.stopPropagation()}>
            <p>Remove <strong>{removeConfirmForm.name || 'this form'}</strong> from favorites?</p>
            <div className="fav-remove-modal-actions">
              <button type="button" className="btn-cancel" onClick={() => setRemoveConfirmForm(null)}>Cancel</button>
              <button type="button" className="btn-remove-confirm" onClick={() => handleRemoveFav(removeConfirmForm.id)}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
