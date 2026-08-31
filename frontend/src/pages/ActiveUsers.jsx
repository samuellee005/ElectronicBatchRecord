import { useState, useEffect, useCallback, useMemo } from 'react'
import { listActiveUsers, saveActiveUsers, listDbUsers } from '../api/client'
import './ActiveUsers.css'

function normalizeRole(r) {
  const v = typeof r === 'string' ? r.trim().toLowerCase() : ''
  return v === 'admin' ? 'admin' : 'user'
}

export default function ActiveUsers() {
  const [users, setUsers] = useState([])
  const [dbUsers, setDbUsers] = useState([])
  const [dbUsersError, setDbUsersError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [picking, setPicking] = useState(false)
  const [pickSearch, setPickSearch] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    listActiveUsers(true)
      .then((res) => {
        if (res.success && Array.isArray(res.users)) {
          setUsers(
            res.users.map((u) => ({
              ...u,
              role: normalizeRole(u.role),
              dbUserId: u.dbUserId ?? null,
              username: u.username || '',
            })),
          )
        } else setUsers([])
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // The account directory backs the picker; without it no roster entry can be linked.
  useEffect(() => {
    listDbUsers()
      .then((res) => {
        if (res.success && Array.isArray(res.users)) {
          setDbUsers(res.users)
          setDbUsersError(null)
        } else {
          setDbUsers([])
          setDbUsersError(res.message || 'Could not read the account directory.')
        }
      })
      .catch((e) => {
        setDbUsers([])
        setDbUsersError(e.message || 'Could not read the account directory.')
      })
  }, [])

  const linkedIds = useMemo(
    () => new Set(users.map((u) => u.dbUserId).filter((x) => x != null)),
    [users],
  )

  const pickable = useMemo(() => {
    const q = pickSearch.trim().toLowerCase()
    return dbUsers
      .filter((d) => !linkedIds.has(d.dbUserId))
      .filter(
        (d) =>
          !q ||
          d.displayName.toLowerCase().includes(q) ||
          d.username.toLowerCase().includes(q) ||
          (d.email || '').toLowerCase().includes(q),
      )
  }, [dbUsers, linkedIds, pickSearch])

  const addFromDirectory = (d) => {
    setUsers((u) => [
      ...u,
      {
        id: `user_${d.dbUserId}_${Date.now()}`,
        displayName: d.displayName,
        username: d.username,
        dbUserId: d.dbUserId,
        active: true,
        role: 'user',
        linked: true,
      },
    ])
    setPicking(false)
    setPickSearch('')
  }

  const removeUser = (idx) => {
    setUsers((u) => u.filter((_, i) => i !== idx))
  }

  const updateUser = (idx, patch) => {
    setUsers((u) => u.map((row, i) => (i === idx ? { ...row, ...patch } : row)))
  }

  const handleSave = async () => {
    const invalid = users.some((x) => !String(x.displayName || '').trim())
    if (invalid) {
      setMessage({ type: 'err', text: 'Every user needs a display name.' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const payload = users.map((x) => ({
        ...x,
        role: normalizeRole(x.role),
      }))
      const res = await saveActiveUsers(payload)
      if (res.success) {
        setMessage({ type: 'ok', text: 'Saved.' })
        setUsers(
          (res.users || payload).map((u) => ({
            ...u,
            role: normalizeRole(u.role),
            dbUserId: u.dbUserId ?? null,
            username: u.username || '',
          })),
        )
      } else {
        setMessage({ type: 'err', text: res.message || 'Save failed' })
      }
    } catch (e) {
      setMessage({ type: 'err', text: e.message || 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  const unlinkedCount = users.filter((u) => u.dbUserId == null).length

  return (
    <div className="active-users-page">
      <header className="au-page-header">
        <h1>User administration</h1>
        <p className="au-lead">
          Maintain the roster of people who can be added as <strong>collaborators</strong> on a batch
          record. Each entry is linked to a real login account, which is what lets the system verify
          that person is present before recording data in their name.
        </p>
        <div className="au-notice" role="note">
          Only linked entries can be added to a batch. An entry with no account cannot be
          re-authenticated, so it cannot be held responsible for an entry.
        </div>
      </header>

      {dbUsersError && (
        <div className="au-notice au-notice--warn" role="alert">
          {dbUsersError} New entries cannot be linked until the account directory is reachable.
        </div>
      )}

      {loading ? (
        <p className="au-loading">Loading…</p>
      ) : (
        <div className="au-card">
          <div className="au-card-title">Directory</div>
          {unlinkedCount > 0 && (
            <div className="au-notice au-notice--warn" role="note">
              {unlinkedCount} entr{unlinkedCount === 1 ? 'y is' : 'ies are'} not linked to an
              account. {unlinkedCount === 1 ? 'It' : 'They'} will not appear when choosing
              collaborators. Remove and re-add from the account directory to fix.
            </div>
          )}
          <div className="au-table-wrap">
            <table className="au-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Active</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => (
                  <tr
                    key={u.id + idx}
                    className={normalizeRole(u.role) === 'admin' ? 'au-row--admin' : undefined}
                  >
                    <td>
                      <input
                        type="text"
                        className="au-input"
                        value={u.displayName}
                        onChange={(e) => updateUser(idx, { displayName: e.target.value })}
                        placeholder="Full name"
                        aria-label={`Display name for ${u.id}`}
                      />
                    </td>
                    <td>
                      {u.dbUserId != null ? (
                        <code className="au-id">{u.username || `#${u.dbUserId}`}</code>
                      ) : (
                        <span className="au-unlinked">Not linked</span>
                      )}
                    </td>
                    <td>
                      <select
                        className="au-role-select"
                        value={normalizeRole(u.role)}
                        onChange={(e) => updateUser(idx, { role: e.target.value })}
                        aria-label={`Role for ${u.displayName || u.id}`}
                      >
                        <option value="user">Standard user</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!u.active}
                        onChange={(e) => updateUser(idx, { active: e.target.checked })}
                        aria-label={`Active: ${u.displayName || u.id}`}
                      />
                    </td>
                    <td>
                      <button type="button" className="au-btn-remove" onClick={() => removeUser(idx)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="au-actions">
            <button
              type="button"
              className="au-btn-add"
              onClick={() => setPicking(true)}
              disabled={dbUsers.length === 0}
            >
              Add from accounts
            </button>
            <button type="button" className="au-btn-save" disabled={saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
          {message && (
            <p className={message.type === 'ok' ? 'au-msg ok' : 'au-msg err'}>{message.text}</p>
          )}
        </div>
      )}

      {picking && (
        <div className="au-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="au-pick-title">
          <div className="au-modal" onClick={(e) => e.stopPropagation()}>
            <h3 id="au-pick-title">Add from accounts</h3>
            <p className="au-modal-desc">
              Pick the person&rsquo;s login account. Their name and username come from the account
              directory, so the roster always points at a real, verifiable identity.
            </p>
            <input
              type="search"
              className="au-input au-pick-search"
              placeholder="Search name, username, or email"
              value={pickSearch}
              onChange={(e) => setPickSearch(e.target.value)}
              autoFocus
            />
            <div className="au-pick-list">
              {pickable.length === 0 ? (
                <p className="au-pick-empty">
                  {dbUsers.length === 0
                    ? 'No accounts available.'
                    : 'No matching accounts that are not already on the roster.'}
                </p>
              ) : (
                pickable.slice(0, 100).map((d) => (
                  <button
                    key={d.dbUserId}
                    type="button"
                    className="au-pick-item"
                    onClick={() => addFromDirectory(d)}
                  >
                    <span className="au-pick-name">{d.displayName}</span>
                    <span className="au-pick-meta">
                      {d.username}
                      {d.email ? ` · ${d.email}` : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="au-modal-actions">
              <button type="button" className="au-btn-remove" onClick={() => setPicking(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
