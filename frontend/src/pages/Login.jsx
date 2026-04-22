import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { apiLogin, getLoginConfig } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useUserPrefs } from '../context/UserPrefsContext'
import './Login.css'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh, authenticated, ready } = useAuth()
  const { updatePrefs } = useUserPrefs()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [requirePassword, setRequirePassword] = useState(false)
  const [bypassDb, setBypassDb] = useState(false)
  const [configLoading, setConfigLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let ok = true
    ;(async () => {
      try {
        const cfg = await getLoginConfig()
        if (ok) {
          setRequirePassword(!!cfg.requirePassword)
          setBypassDb(!!cfg.bypassDb)
        }
      } catch {
        if (ok) setRequirePassword(false)
      } finally {
        if (ok) setConfigLoading(false)
      }
    })()
    return () => {
      ok = false
    }
  }, [])

  useEffect(() => {
    if (ready && authenticated) {
      const to = location.state?.from?.pathname || '/'
      navigate(to, { replace: true })
    }
  }, [ready, authenticated, navigate, location.state])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    const u = username.trim()
    if (!u) {
      setError('Enter a username.')
      return
    }
    if (requirePassword && !password) {
      setError('Enter your password.')
      return
    }
    setSubmitting(true)
    try {
      const body = requirePassword
        ? { username: u, password }
        : { username: u }
      const res = await apiLogin(body)
      if (!res.success) {
        const msg = res.message || 'Login failed'
        // If /includes/login-config.php was missing or failed, we may not show a password
        // field even when the server has EBR_REQUIRE_PASSWORD=1 — recover on first attempt.
        if (!requirePassword && /password is required/i.test(String(msg))) {
          setRequirePassword(true)
          setError('This server requires a password. Enter it below and try again.')
          return
        }
        setError(msg)
        return
      }
      await refresh()
      const dn = res.user?.displayName || res.user?.username || u
      updatePrefs({ ebrUserDisplayName: dn })
      const to = location.state?.from?.pathname || '/'
      navigate(to, { replace: true })
    } catch (err) {
      setError(err.message || 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Electronic Batch Record</h1>
        <p className="login-subtitle">Sign in with your account</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label">
            Username
            <input
              className="login-input"
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting || configLoading}
            />
          </label>
          {requirePassword ? (
            <label className="login-label">
              Password
              <input
                className="login-input"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </label>
          ) : null}
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          <button type="submit" className="login-submit" disabled={submitting || configLoading}>
            {submitting ? 'Signing in…' : configLoading ? 'Loading…' : 'Sign in'}
          </button>
        </form>
        <p className="login-hint">
          {bypassDb
            ? (
              <span>
                <strong>Dev server:</strong> <code>EBR_LOGIN_BYPASS_DB=1</code> is on — enter any username to
                sign in. When you move to production, turn off bypass and use the <code>db_user</code> table. Set{' '}
                <code>EBR_ADMIN_USERNAMES</code> for admin in the UI. Use <code>EBR_REQUIRE_LOGIN=1</code> to
                require a session for API calls.
              </span>
            ) : (
              <span>
                Sign-in uses the read-only <code>db_user</code> table; users are not created in this app. Set{' '}
                <code>EBR_ADMIN_USERNAMES=user1,user2</code> for admin. On a dev server without
                that table, set <code>EBR_LOGIN_BYPASS_DB=1</code>. Use <code>EBR_REQUIRE_LOGIN=1</code> for
                protected APIs; <code>EBR_REQUIRE_PASSWORD=1</code> to require a password.
              </span>
            )}
        </p>
      </div>
    </div>
  )
}
