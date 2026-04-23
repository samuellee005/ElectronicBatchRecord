import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getUserInitials } from '../utils/userInitials'
import './Profile.css'

export default function Profile() {
  const { user } = useAuth()
  if (!user) return null

  const initials = getUserInitials(user)
  const display = user.displayName || user.username

  return (
    <div className="profile-page page-content">
      <h1 className="page-title">My profile</h1>

      <div className="profile-card">
        <div className="profile-card__hero">
          <span className="profile-card__avatar" aria-hidden>
            {initials}
          </span>
          <div className="profile-card__hero-text">
            <h2 className="profile-card__name">{display}</h2>
            <p className="profile-card__username">@{user.username}</p>
            <span className={`profile-role profile-role--${user.role === 'admin' ? 'admin' : 'user'}`}>
              {user.role === 'admin' ? 'Administrator' : 'User'}
            </span>
          </div>
        </div>

        <section className="profile-session" id="session" aria-labelledby="profile-session-heading">
          <h3 id="profile-session-heading" className="profile-session__title">
            Session and account info
          </h3>
        <dl className="profile-dl">
          <dt>User ID</dt>
          <dd>{user.id}</dd>
          <dt>Username</dt>
          <dd>{user.username}</dd>
          <dt>Display name</dt>
          <dd>{user.displayName || '—'}</dd>
          <dt>Role in this app</dt>
          <dd>{user.role}</dd>
        </dl>
        </section>

        <p className="profile-note">
          Session and account details come from your current sign-in. Administrators are set via{' '}
          <code>EBR_ADMIN_USERNAMES</code> on the server.
        </p>

        <Link to="/" className="btn btn-primary profile-back">
          Back to home
        </Link>
      </div>
    </div>
  )
}
