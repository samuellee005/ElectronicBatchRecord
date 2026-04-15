import { useState, useEffect, useCallback } from 'react'
import { listActiveUsers, saveActiveUsers } from '../api/client'
import './ActiveUsers.css'

function normalizeRole(r) {
  const v = typeof r === 'string' ? r.trim().toLowerCase() : ''
  return v === 'admin' ? 'admin' : 'user'
}

export default function ActiveUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    listActiveUsers(true)
      .then((res) => {
        if (res.success && Array.isArray(res.users)) {
          setUsers(
            res.users.map((u) => ({
              ...u,
              role: normalizeRole(u.role),
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

  const addUser = () => {
    setUsers((u) => [
      ...u,
      { id: `user_${Date.now()}`, displayName: '', active: true, role: 'user' },
    ])
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

  return (
    <div className="active-users-page">
      <header className="au-page-header">
        <h1>User administration</h1>
        <p className="au-lead">
          Maintain the roster used for <strong>Collaborator Entry</strong> (primary analyst and secondary reviewer)
          and assign each person as an <strong>administrator</strong> or <strong>standard user</strong> for recordkeeping.
        </p>
        <div className="au-notice" role="note">
          Roles are stored with this roster for audit and future access control. This screen does not require a separate
          login in the current version.
        </div>
      </header>

      {loading ? (
        <p className="au-loading">Loading…</p>
      ) : (
        <div className="au-card">
          <div className="au-card-title">Directory</div>
          <div className="au-table-wrap">
            <table className="au-table">
              <thead>
                <tr>
                  <th>Display name</th>
                  <th>Role</th>
                  <th>ID (internal)</th>
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
                      <code className="au-id">{u.id}</code>
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
            <button type="button" className="au-btn-add" onClick={addUser}>
              Add user
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
    </div>
  )
}
