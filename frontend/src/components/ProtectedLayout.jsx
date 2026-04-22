import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import Nav from './Nav'

/**
 * Shell with nav; redirects to /login until the PHP session is authenticated.
 */
export default function ProtectedLayout() {
  const { ready, authenticated } = useAuth()
  const location = useLocation()

  if (!ready) {
    return (
      <div className="app-shell">
        <main className="main">
          <p className="page-content" style={{ padding: '2rem' }}>
            Loading…
          </p>
        </main>
      </div>
    )
  }

  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  const wideMain =
    location.pathname.startsWith('/forms/builder') || location.pathname.startsWith('/forms/entry')

  return (
    <div className="app-shell">
      <Nav />
      <main className={wideMain ? 'main main--wide' : 'main'}>
        <Outlet />
      </main>
    </div>
  )
}
