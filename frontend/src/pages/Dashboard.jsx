import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline'
import { listForms, listBatchRecords, getDownloadBatchPdfUrl } from '../api/client'
import { useUserPrefs } from '../context/UserPrefsContext'
import WidgetActionMenu from '../components/WidgetActionMenu'
import './Dashboard.css'

const WIDGET_LIMIT = 5
const ALL_WIDGET_IDS = ['favorites', 'myForms', 'openBatches', 'completedBatches', 'reminders']

function normalizeWidgetOrder(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return [...ALL_WIDGET_IDS]
  }
  const seen = new Set()
  const ordered = []
  for (const id of raw) {
    if (ALL_WIDGET_IDS.includes(id) && !seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  for (const id of ALL_WIDGET_IDS) {
    if (!seen.has(id)) ordered.push(id)
  }
  return ordered
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

function moveWidgetInOrder(order, fromId, toId) {
  if (fromId === toId) return order
  const next = [...order]
  const fromIdx = next.indexOf(fromId)
  const toIdx = next.indexOf(toId)
  if (fromIdx === -1 || toIdx === -1) return order
  next.splice(fromIdx, 1)
  const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx
  next.splice(insertAt, 0, fromId)
  return next
}

const WIDGET_TITLES = {
  favorites: '★ Favorite forms',
  myForms: '📋 Forms you have built',
  openBatches: '📂 My open batches',
  completedBatches: '✓ Recently completed (mine)',
  reminders: '🔔 Reminders',
}

const WIDGET_RESTORE_LABELS = {
  favorites: 'Favorite forms',
  myForms: 'Forms you built',
  openBatches: 'Open batches',
  completedBatches: 'Recently completed',
  reminders: 'Reminders',
}

export default function Dashboard() {
  const { prefs, ready, updatePrefs } = useUserPrefs()
  const [forms, setForms] = useState([])
  const [groupedForms, setGroupedForms] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [nameInput, setNameInput] = useState('')
  const [favPopover, setFavPopover] = useState(null)
  const [removeConfirmForm, setRemoveConfirmForm] = useState(null)
  const [myOpenBatches, setMyOpenBatches] = useState([])
  const [myCompletedBatches, setMyCompletedBatches] = useState([])
  const [batchesLoading, setBatchesLoading] = useState(false)

  const [dragOverId, setDragOverId] = useState(null)

  const widgetOrder = useMemo(
    () => normalizeWidgetOrder(prefs.ebrDashboardOrder),
    [prefs.ebrDashboardOrder],
  )
  const hiddenWidgets = useMemo(() => {
    const h = prefs.ebrDashboardHidden
    return Array.isArray(h) ? h.filter((id) => ALL_WIDGET_IDS.includes(id)) : []
  }, [prefs.ebrDashboardHidden])
  const favorites = useMemo(
    () => (Array.isArray(prefs.ebrFavorites) ? prefs.ebrFavorites : []),
    [prefs.ebrFavorites],
  )
  const userName = useMemo(() => (prefs.ebrUserDisplayName || '').trim(), [prefs.ebrUserDisplayName])
  const resolved = useMemo(() => {
    const r = prefs.ebrFavoriteResolved
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {}
  }, [prefs.ebrFavoriteResolved])
  const lastSeen = useMemo(() => {
    const s = prefs.ebrFormLastSeen
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {}
  }, [prefs.ebrFormLastSeen])

  useEffect(() => {
    if (ready) setNameInput(prefs.ebrUserDisplayName || '')
  }, [ready, prefs.ebrUserDisplayName])

  const hideWidget = useCallback(
    (id) => {
      if (hiddenWidgets.includes(id)) return
      updatePrefs({ ebrDashboardHidden: [...hiddenWidgets, id] })
    },
    [hiddenWidgets, updatePrefs],
  )

  const restoreWidget = useCallback(
    (id) => {
      updatePrefs({ ebrDashboardHidden: hiddenWidgets.filter((x) => x !== id) })
    },
    [hiddenWidgets, updatePrefs],
  )

  const onDragStartWidget = useCallback((e, id) => {
    e.dataTransfer.setData('text/widget-id', id)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const onDragOverWidget = useCallback((e, id) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(id)
  }, [])

  const onDragLeaveWidget = useCallback(() => {
    setDragOverId(null)
  }, [])

  const onDropWidget = useCallback(
    (e, targetId) => {
      e.preventDefault()
      setDragOverId(null)
      const fromId = e.dataTransfer.getData('text/widget-id')
      if (!fromId || fromId === targetId) return
      const next = moveWidgetInOrder(widgetOrder, fromId, targetId)
      updatePrefs({ ebrDashboardOrder: next })
    },
    [widgetOrder, updatePrefs],
  )

  useEffect(() => {
    const clearDrop = () => setDragOverId(null)
    window.addEventListener('dragend', clearDrop)
    return () => window.removeEventListener('dragend', clearDrop)
  }, [])

  useEffect(() => {
    listForms()
      .then((data) => {
        setForms(data.forms || [])
        setGroupedForms(data.groupedForms || {})
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const name = (userName || '').trim()
    if (!name) {
      setMyOpenBatches([])
      setMyCompletedBatches([])
      return
    }
    setBatchesLoading(true)
    Promise.all([listBatchRecords('in_progress', name), listBatchRecords('completed', name)])
      .then(([openRes, doneRes]) => {
        setMyOpenBatches(openRes.records || [])
        const done = (doneRes.records || []).slice()
        done.sort((a, b) => {
          const ta = new Date(a.completedAt || a.updatedAt || 0).getTime()
          const tb = new Date(b.completedAt || b.updatedAt || 0).getTime()
          return tb - ta
        })
        setMyCompletedBatches(done)
      })
      .catch(() => {
        setMyOpenBatches([])
        setMyCompletedBatches([])
      })
      .finally(() => setBatchesLoading(false))
  }, [userName])

  const downloadBatchPdf = (batchId, title) => {
    const url = getDownloadBatchPdfUrl(batchId)
    fetch(url)
      .then((res) => {
        const ct = res.headers.get('Content-Type') || ''
        if (ct.includes('application/json')) {
          return res.json().then((data) => {
            if (!data.success) throw new Error(data.message || 'Download failed')
          })
        }
        if (!res.ok) throw new Error('Download failed')
        return res.blob()
      })
      .then((blob) => {
        if (blob instanceof Blob) {
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = (title || 'batch').replace(/[^\w-]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.pdf'
          a.click()
          URL.revokeObjectURL(a.href)
        }
      })
      .catch((err) => alert(err.message || 'Could not download PDF'))
  }

  function formatBatchDate(iso) {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    } catch {
      return iso
    }
  }

  const favForms = forms.filter((f) => favorites.includes(f.id))
  const latestByKey = buildLatestByKey(groupedForms)
  const myForms = userName ? forms.filter((f) => (f.createdBy || '').trim() === userName) : []
  myForms.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))

  const reminders = useMemo(() => {
    const list = []
    Object.keys(groupedForms || {}).forEach((k) => {
      const group = groupedForms[k]
      if (!group || !group.length) return
      const latest = group[0]
      const groupKey = (latest.name || '') + '|' + (latest.pdfFile || '')
      const lastVersion = lastSeen[groupKey] || 0
      const curVersion = latest.version || 1
      if (curVersion > lastVersion) {
        list.push({
          name: latest.name,
          pdf: latest.pdfFile,
          version: curVersion,
          formId: latest.id,
          key: groupKey,
        })
      }
    })
    return list
  }, [groupedForms, lastSeen])

  const favoritedKeys = {}
  forms.forEach((f) => {
    if (favorites.includes(f.id)) favoritedKeys[(f.name || '') + '|' + (f.pdfFile || '')] = true
  })

  const handleReplaceFav = (oldId, latestId, groupKey, latestVer) => {
    let favs = favorites.filter((id) => id !== oldId)
    if (!favs.includes(latestId)) favs.push(latestId)
    updatePrefs({
      ebrFavorites: favs,
      ebrFavoriteResolved: { ...resolved, [groupKey]: latestVer },
    })
    setFavPopover(null)
  }
  const handleDismissNewer = (groupKey, latestVer) => {
    updatePrefs({ ebrFavoriteResolved: { ...resolved, [groupKey]: latestVer } })
    setFavPopover(null)
  }
  const handleRemoveFav = (formId) => {
    updatePrefs({ ebrFavorites: favorites.filter((id) => id !== formId) })
    setRemoveConfirmForm(null)
  }
  const handleSaveName = () => {
    const name = nameInput.trim()
    if (name) updatePrefs({ ebrUserDisplayName: name })
  }

  const visibleWidgetIds = useMemo(
    () => widgetOrder.filter((id) => !hiddenWidgets.includes(id)),
    [widgetOrder, hiddenWidgets],
  )

  const renderWidgetBody = (id) => {
    switch (id) {
      case 'favorites':
        return favForms.length === 0 ? (
          <p className="widget-empty">
            No favorites yet. Star forms on <Link to="/forms">Batch Record Forms</Link> to add them here.
          </p>
        ) : (
          <>
            <ul className="widget-list" id="favoritesList">
              {favForms.slice(0, WIDGET_LIMIT).map((f) => {
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
                          >
                            !
                          </span>
                          {popoverOpen && (
                            <div className="fav-newer-popover show" onMouseLeave={() => setFavPopover(null)}>
                              <p>A newer version (v{latest.version || 1}) is available.</p>
                              <div className="fav-popover-actions">
                                <button type="button" className="btn-replace" onClick={() => handleReplaceFav(f.id, latest.id, groupKey, latest.version || 1)}>
                                  Replace with new version
                                </button>
                                <button type="button" className="btn-dismiss" onClick={() => handleDismissNewer(groupKey, latest.version || 1)}>
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <div className="fav-item-actions">
                      <WidgetActionMenu
                        items={[
                          { label: 'Use', to: `/forms/entry?form=${encodeURIComponent(f.id)}` },
                          ...(f.pdfFile
                            ? [{ label: 'View form', to: `/forms/builder?file=${encodeURIComponent(f.pdfFile)}&formId=${encodeURIComponent(f.id)}` }]
                            : []),
                          { label: 'Remove from favorites', onClick: () => setRemoveConfirmForm(f) },
                        ]}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
            {favForms.length > WIDGET_LIMIT && (
              <p className="widget-empty" style={{ marginTop: 8 }}>
                <Link to="/forms">View all favorites ({favForms.length})</Link>
              </p>
            )}
          </>
        )
      case 'myForms':
        return !userName ? (
          <>
            <p className="widget-empty">Set your name to see forms you have built.</p>
            <input type="text" className="widget-name-input" placeholder="Your name" maxLength={100} value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
            <br />
            <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={handleSaveName}>
              Save name
            </button>
          </>
        ) : myForms.length === 0 ? (
          <p className="widget-empty">
            No forms built by you yet. Build forms from <Link to="/templates">Templates</Link>.
          </p>
        ) : (
          <>
            <ul className="widget-list">
              {myForms.slice(0, WIDGET_LIMIT).map((f) => (
                <li key={f.id}>
                  <span>
                    {f.name} (v{f.version ?? 1})
                  </span>
                  <WidgetActionMenu
                    items={[
                      { label: 'Use', to: `/forms/entry?form=${encodeURIComponent(f.id)}` },
                      ...(f.pdfFile
                        ? [{ label: 'View form', to: `/forms/builder?file=${encodeURIComponent(f.pdfFile)}&formId=${encodeURIComponent(f.id)}` }]
                        : []),
                    ]}
                  />
                </li>
              ))}
            </ul>
            {myForms.length > WIDGET_LIMIT && (
              <p className="widget-empty" style={{ marginTop: 8 }}>
                <Link to="/forms">View all ({myForms.length})</Link>
              </p>
            )}
          </>
        )
      case 'openBatches':
        return !userName ? (
          <p className="widget-empty">Set your name (in Forms you have built) to see batch records you created.</p>
        ) : batchesLoading ? (
          <p className="widget-empty">Loading…</p>
        ) : myOpenBatches.length === 0 ? (
          <p className="widget-empty">
            No in-progress batches. Start one from <Link to="/forms">Batch Record Forms</Link>.
          </p>
        ) : (
          <>
            <ul className="widget-list widget-batch-list">
              {myOpenBatches.slice(0, WIDGET_LIMIT).map((b) => (
                <li key={b.id}>
                  <div className="widget-batch-meta">
                    <span className="widget-batch-title">{b.title || '—'}</span>
                    <span className="widget-batch-number" title="Batch number">
                      {b.batchId ?? b.id}
                    </span>
                    <span className="widget-batch-sub">
                      {b.formName || '—'} · Updated {formatBatchDate(b.updatedAt)}
                    </span>
                  </div>
                  <WidgetActionMenu
                    items={[
                      { label: 'Resume', to: `/forms/entry?form=${encodeURIComponent(b.formId)}&batch=${encodeURIComponent(b.batchId ?? b.id)}` },
                      ...(b.pdfFile && b.formId
                        ? [{ label: 'View form', to: `/forms/builder?file=${encodeURIComponent(b.pdfFile)}&formId=${encodeURIComponent(b.formId)}` }]
                        : []),
                    ]}
                  />
                </li>
              ))}
            </ul>
            {userName && !batchesLoading && myOpenBatches.length > WIDGET_LIMIT && (
              <p className="widget-empty" style={{ marginTop: 8 }}>
                <Link to="/batch?filter=in-progress">View all in progress ({myOpenBatches.length})</Link>
              </p>
            )}
          </>
        )
      case 'completedBatches':
        return !userName ? (
          <p className="widget-empty">Set your name to see batches you completed.</p>
        ) : batchesLoading ? (
          <p className="widget-empty">Loading…</p>
        ) : myCompletedBatches.length === 0 ? (
          <p className="widget-empty">No completed batches yet.</p>
        ) : (
          <>
            <ul className="widget-list widget-batch-list">
              {myCompletedBatches.slice(0, WIDGET_LIMIT).map((b) => (
                <li key={b.id}>
                  <div className="widget-batch-meta">
                    <span className="widget-batch-title">{b.title || '—'}</span>
                    <span className="widget-batch-number" title="Batch number">
                      {b.batchId ?? b.id}
                    </span>
                    <span className="widget-batch-sub">
                      {b.formName || '—'} · Completed {formatBatchDate(b.completedAt)}
                    </span>
                  </div>
                  <WidgetActionMenu
                    items={[
                      { label: 'View', to: `/forms/entry?form=${encodeURIComponent(b.formId)}&batch=${encodeURIComponent(b.batchId ?? b.id)}` },
                      ...(b.pdfFile && b.formId
                        ? [{ label: 'View form', to: `/forms/builder?file=${encodeURIComponent(b.pdfFile)}&formId=${encodeURIComponent(b.formId)}` }]
                        : []),
                      { label: 'Download PDF', onClick: () => downloadBatchPdf(b.batchId ?? b.id, b.title) },
                    ]}
                  />
                </li>
              ))}
            </ul>
            {userName && !batchesLoading && myCompletedBatches.length > WIDGET_LIMIT && (
              <p className="widget-empty" style={{ marginTop: 8 }}>
                <Link to="/batch?filter=completed">View all completed ({myCompletedBatches.length})</Link>
              </p>
            )}
          </>
        )
      case 'reminders':
        return reminders.length === 0 ? (
          <p className="widget-empty">No new updates. Forms you use will show here when a new version is available.</p>
        ) : (
          <>
            {reminders.slice(0, WIDGET_LIMIT).map((r) => (
              <div key={r.key} className="reminder-item">
                <div className="reminder-item-main">
                  <div className="reminder-item-title-row">
                    <strong>{r.name}</strong>
                    <span className="reminder-badge">New v{r.version}</span>
                    {favoritedKeys[r.key] && <span className="reminder-fav-badge" title="This form is in your favorites">!</span>}
                  </div>
                  <p>A new version of this form is available.</p>
                </div>
                <div className="reminder-item-actions">
                  <WidgetActionMenu
                    items={[
                      { label: 'Use new version', to: `/forms/entry?form=${encodeURIComponent(r.formId)}` },
                      ...(r.pdf ? [{ label: 'View form', to: `/forms/builder?file=${encodeURIComponent(r.pdf)}&formId=${encodeURIComponent(r.formId)}` }] : []),
                    ]}
                  />
                </div>
              </div>
            ))}
            {reminders.length > WIDGET_LIMIT && (
              <p className="widget-empty" style={{ marginTop: 8 }}>
                <Link to="/forms">View more forms ({reminders.length} updates)</Link>
              </p>
            )}
          </>
        )
      default:
        return null
    }
  }

  if (loading) return <div className="dashboard"><h1>Dashboard</h1><p>Loading…</p></div>
  if (error)
    return (
      <div className="dashboard">
        <h1>Dashboard</h1>
        <p className="error-message">Could not load forms: {error}</p>
      </div>
    )

  return (
    <div className="dashboard">
      <div className="dashboard-top">
        <h1>Dashboard</h1>
        <p className="dashboard-hint">Drag the grip on a widget to reorder. Use × to hide a widget.</p>
      </div>

      {hiddenWidgets.length > 0 && (
        <div className="dashboard-hidden-bar">
          <span className="dashboard-hidden-label">Hidden widgets:</span>
          {hiddenWidgets.map((id) => (
            <button key={id} type="button" className="dashboard-restore-btn" onClick={() => restoreWidget(id)}>
              Show {WIDGET_RESTORE_LABELS[id] || id}
            </button>
          ))}
        </div>
      )}

      <div className="widgets">
        {visibleWidgetIds.length === 0 ? (
          <p className="widget-empty dashboard-all-hidden">All widgets are hidden. Use the buttons above to show them again.</p>
        ) : (
          visibleWidgetIds.map((id) => (
            <div
              key={id}
              className={'widget widget-shell' + (dragOverId === id ? ' widget-shell-drop-target' : '')}
              onDragOver={(e) => onDragOverWidget(e, id)}
              onDragLeave={onDragLeaveWidget}
              onDrop={(e) => onDropWidget(e, id)}
            >
              <div className="widget-header widget-header-with-controls">
                <span
                  className="widget-drag-handle"
                  draggable
                  onDragStart={(e) => onDragStartWidget(e, id)}
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  role="button"
                >
                  <Bars3Icon className="widget-drag-icon" />
                </span>
                <span className="widget-header-text">{WIDGET_TITLES[id]}</span>
                <button type="button" className="widget-remove-btn" onClick={() => hideWidget(id)} title="Remove from dashboard" aria-label="Remove widget">
                  <XMarkIcon className="widget-remove-icon" />
                </button>
              </div>
              <div className="widget-body">{renderWidgetBody(id)}</div>
            </div>
          ))
        )}
      </div>

      {removeConfirmForm && (
        <div className="fav-remove-modal-backdrop" onClick={() => setRemoveConfirmForm(null)}>
          <div className="fav-remove-modal" onClick={(e) => e.stopPropagation()}>
            <p>
              Remove <strong>{removeConfirmForm.name || 'this form'}</strong> from favorites?
            </p>
            <div className="fav-remove-modal-actions">
              <button type="button" className="btn-cancel" onClick={() => setRemoveConfirmForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn-remove-confirm" onClick={() => handleRemoveFav(removeConfirmForm.id)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
