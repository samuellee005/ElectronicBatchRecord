import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listDbUsers, listFormCollaborators, updateFormCollaborators } from '../api/client'
import './ManageFormAccess.css'

/**
 * Who may edit a form, and who may change that list.
 *
 * Owners can edit the form and manage access; editors can only edit the form.
 * A form always keeps at least one owner, so the last owner cannot be removed
 * or demoted — the server enforces that too (includes/form-collaborators.php).
 *
 * Changes are saved as they are made: this dialog has no Save button, because
 * granting access is not part of saving a form version.
 *
 * @param {{ formId: string, formName?: string, onClose: () => void, onChanged?: (roster: object[]) => void }} props
 */
export default function ManageFormAccess({ formId, formName, onClose, onChanged }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [roster, setRoster] = useState([])
  const [canManage, setCanManage] = useState(false)
  const [creator, setCreator] = useState(null)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const closeRef = useRef(null)

  // Held in a ref: callers pass an inline function, so depending on it directly
  // would re-run the load effect on every parent render — the dialog would sit
  // there flickering between "Loading…" and the list.
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])

  const applyPayload = useCallback((data) => {
    const next = Array.isArray(data.collaborators) ? data.collaborators : []
    setRoster(next)
    setCanManage(!!data.canManage)
    setCreator(data.creator || null)
    setNotice(data.message || null)
    onChangedRef.current?.(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listFormCollaborators(formId)
      .then((data) => {
        if (cancelled) return
        if (!data.success) throw new Error(data.message || 'Could not load access list')
        applyPayload(data)
        setError(null)
      })
      .catch((e) => !cancelled && setError(e.message || 'Could not load access list'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [formId, applyPayload])

  // Escape closes; focus starts on the close button so the dialog is keyboard-usable.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Directory search, debounced, excluding people who already have access.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) {
      setResults([])
      return undefined
    }
    const t = setTimeout(() => {
      listDbUsers(q)
        .then((data) => {
          const taken = new Set(roster.map((r) => r.dbUserId))
          setResults((data.users || []).filter((u) => !taken.has(u.dbUserId)).slice(0, 8))
        })
        .catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [search, roster])

  const owners = useMemo(() => roster.filter((r) => r.role === 'owner'), [roster])
  const lastOwnerId = owners.length === 1 ? owners[0].dbUserId : null

  const submit = useCallback(
    async (body, { clearSearch = false } = {}) => {
      setSaving(true)
      setError(null)
      try {
        const data = await updateFormCollaborators({ formId, ...body })
        if (!data.success) throw new Error(data.message || 'Could not update access')
        applyPayload(data)
        if (clearSearch) {
          setSearch('')
          setResults([])
        }
      } catch (e) {
        setError(e.message || 'Could not update access')
      } finally {
        setSaving(false)
      }
    },
    [formId, applyPayload],
  )

  const label = (person) => person.displayName || person.username || `User #${person.dbUserId}`

  return (
    <div className="mfa-overlay" onClick={onClose}>
      <div
        className="mfa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mfa-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mfa-head">
          <h3 id="mfa-title">Manage access</h3>
          <button type="button" className="mfa-close" onClick={onClose} ref={closeRef} aria-label="Close">
            ×
          </button>
        </div>
        {formName && <p className="mfa-subtitle">{formName}</p>}

        {loading ? (
          <p className="mfa-muted">Loading…</p>
        ) : (
          <>
            {!canManage && (
              <p className="mfa-readonly">
                Only an owner of this form can change who has access. You can see the list below.
              </p>
            )}
            {error && <p className="mfa-error">{error}</p>}
            {notice && <p className="mfa-notice">{notice}</p>}

            <ul className="mfa-list">
              {roster.length === 0 && (
                <li className="mfa-muted mfa-empty">
                  No one has been given access yet, so anyone can edit this form.
                </li>
              )}
              {roster.map((person) => {
                const isLastOwner = person.role === 'owner' && person.dbUserId === lastOwnerId
                const lockReason = isLastOwner
                  ? 'A form must keep at least one owner. Make someone else an owner first.'
                  : undefined
                return (
                  <li className="mfa-row" key={person.dbUserId || person.username}>
                    <div className="mfa-person">
                      <span className="mfa-name">{label(person)}</span>
                      <span className="mfa-meta">
                        {person.username}
                        {person.isCreator ? ' · created this form' : ''}
                      </span>
                    </div>
                    <select
                      className="mfa-role"
                      value={person.role}
                      disabled={!canManage || saving || isLastOwner || !person.dbUserId}
                      title={lockReason}
                      onChange={(e) =>
                        submit({ setRole: [{ dbUserId: person.dbUserId, role: e.target.value }] })
                      }
                    >
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                    </select>
                    <button
                      type="button"
                      className="mfa-remove"
                      disabled={!canManage || saving || isLastOwner}
                      title={lockReason || 'Remove access'}
                      onClick={() => submit({ remove: [person.dbUserId] })}
                    >
                      Remove
                    </button>
                  </li>
                )
              })}
            </ul>

            {canManage && (
              <div className="mfa-add">
                <label htmlFor="mfa-search">Add someone</label>
                <input
                  id="mfa-search"
                  type="text"
                  className="mfa-search"
                  placeholder="Search users by name or username…"
                  value={search}
                  disabled={saving}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {results.length > 0 && (
                  <ul className="mfa-results">
                    {results.map((u) => (
                      <li key={u.dbUserId}>
                        <button
                          type="button"
                          className="mfa-result-btn"
                          disabled={saving}
                          onClick={() =>
                            submit({ add: [{ dbUserId: u.dbUserId, role: 'editor' }] }, { clearSearch: true })
                          }
                        >
                          <span className="mfa-name">{u.displayName || u.username}</span>
                          <span className="mfa-meta">{u.email || u.username}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {search.trim().length >= 2 && results.length === 0 && (
                  <p className="mfa-muted">No matching accounts.</p>
                )}
              </div>
            )}

            <p className="mfa-hint">
              Owners can edit this form and change who has access. Editors can edit the form only.
              Access covers every version of the form
              {creator?.name ? `, which was created by ${creator.name}` : ''}.
            </p>
          </>
        )}

        <div className="mfa-actions">
          <button type="button" className="mfa-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
