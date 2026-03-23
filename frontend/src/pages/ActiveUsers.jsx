import { useState, useEffect, useCallback } from 'react'
import { listActiveUsers, saveActiveUsers } from '../api/client'
import './ActiveUsers.css'

export default function ActiveUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    listActiveUsers(true)
      .then((res) => {
        if (res.success && Array.isArray(res.users)) setUsers(res.users)
        else setUsers([])
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
      { id: `user_${Date.now()}`, displayName: '', active: true },
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
      const res = await saveActiveUsers(users)
      if (res.success) {
        setMessage({ type: 'ok', text: 'Saved.' })
        setUsers(res.users || users)
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
      <div className="au-header">
        <h1>Active users</h1>
        <p className="au-intro">
          Users listed here appear in <strong>Collaborator Entry</strong> dropdowns (primary analyst and secondary reviewer).
        </p>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="au-card">
          <table className="au-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>ID (internal)</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u, idx) => (
                <tr key={u.id + idx}>
                  <td>
                    <input
                      type="text"
                      className="au-input"
                      value={u.displayName}
                      onChange={(e) => updateUser(idx, { displayName: e.target.value })}
                      placeholder="Full name"
                    />
                  </td>
                  <td>
                    <code className="au-id">{u.id}</code>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!u.active}
                      onChange={(e) => updateUser(idx, { active: e.target.checked })}
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
