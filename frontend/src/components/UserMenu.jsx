import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { UserCircleIcon, ArrowRightOnRectangleIcon, InformationCircleIcon } from '@heroicons/react/24/outline'
import { useAuth } from '../context/AuthContext'
import { getUserInitials } from '../utils/userInitials'
import './UserMenu.css'

/**
 * Fixed top-right account menu (avatar, profile, sign out). Rendered in `ProtectedLayout` after main.
 * @param {{ onOpenMenu?: () => void }} [props]
 */
export default function UserMenu({ onOpenMenu }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    close()
  }, [location.pathname, close])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!user) return null

  const initials = getUserInitials(user)
  const label = user.displayName || user.username || 'Account'

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev
      if (next && onOpenMenu) onOpenMenu()
      return next
    })
  }

  const handleSignOut = async () => {
    close()
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div ref={wrapRef} className={`user-menu${open ? ' user-menu--open' : ''}`}>
      <button
        type="button"
        className="user-menu__trigger"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Account menu for ${label}`}
        onClick={toggle}
      >
        <span className="user-menu__avatar" aria-hidden>
          {initials}
        </span>
        <span className="user-menu__label">
          <span className="user-menu__name">{label}</span>
          <span className="user-menu__chevron" aria-hidden>
            ▾
          </span>
        </span>
      </button>

      {open ? (
        <div className="user-menu__dropdown" role="menu">
          <div className="user-menu__dropdown-head">
            <span className="user-menu__dropdown-name">{label}</span>
            <span className="user-menu__dropdown-meta">@{user.username}</span>
          </div>
          <Link to="/profile" className="user-menu__item" role="menuitem" onClick={close}>
            <UserCircleIcon className="user-menu__item-icon" aria-hidden />
            My profile
          </Link>
          <Link to="/profile#session" className="user-menu__item" role="menuitem" onClick={close}>
            <InformationCircleIcon className="user-menu__item-icon" aria-hidden />
            Session and account info
          </Link>
          <button type="button" className="user-menu__item user-menu__item--danger" role="menuitem" onClick={handleSignOut}>
            <ArrowRightOnRectangleIcon className="user-menu__item-icon" aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
