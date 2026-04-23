import { useState, useCallback, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useUserPrefs } from '../context/UserPrefsContext'
import {
  HomeIcon,
  RectangleStackIcon,
  DocumentDuplicateIcon,
  ClipboardDocumentListIcon,
  MagnifyingGlassIcon,
  UsersIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'
import './Nav.css'

export default function Nav() {
  const { prefs, updatePrefs } = useUserPrefs()
  const location = useLocation()
  const [openDropdown, setOpenDropdown] = useState(null)
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const v = prefs.ebrSidebarCollapsed
    if (v === true || v === '1') setCollapsed(true)
    else if (v === false || v === '0') setCollapsed(false)
  }, [prefs.ebrSidebarCollapsed])
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      updatePrefs({ ebrSidebarCollapsed: next })
      return next
    })
  }, [updatePrefs])

  const isActive = (path, match) => {
    if (match === 'batch') return location.pathname === '/batch'
    if (match === 'templates') return location.pathname.startsWith('/templates')
    if (match === 'forms') return location.pathname.startsWith('/forms') && !location.pathname.startsWith('/forms/build')
    if (match === 'data-search') return location.pathname === '/data-search'
    if (match === 'active-users') return location.pathname === '/active-users'
    if (match === 'home') return location.pathname === '/'
    return false
  }

  const toggle = (key) => {
    setOpenDropdown((prev) => (prev === key ? null : key))
  }

  const closeDropdowns = useCallback(() => {
    setOpenDropdown(null)
  }, [])

  return (
    <aside className={`app-nav${collapsed ? ' app-nav--collapsed' : ''}`} aria-label="Main navigation">
      <div className="app-nav-brand">
        <Link to="/" className="app-nav-logo" title="Electronic Batch Record — Home" onClick={closeDropdowns}>
          <HomeIcon className="app-nav-logo-icon" aria-hidden />
          <span className="app-nav-logo-text">Electronic Batch Record</span>
        </Link>
      </div>

      <ul id="app-nav-links" className="app-nav-links">
        <li
          className={
            'app-nav-dropdown ' +
            (isActive(null, 'batch') ? 'active ' : '') +
            (openDropdown === 'batch' ? 'open' : '')
          }
        >
          <button
            type="button"
            className="app-nav-item app-nav-dropdown-trigger"
            aria-expanded={openDropdown === 'batch'}
            aria-haspopup="true"
            onClick={(e) => {
              e.stopPropagation()
              toggle('batch')
            }}
          >
            <RectangleStackIcon className="app-nav-item-icon" aria-hidden />
            <span className="app-nav-item-label">Batch Record</span>
            <span className="app-nav-arrow" aria-hidden>
              ▾
            </span>
          </button>
          <ul className="app-nav-dropdown-menu">
            <li>
              <Link to="/batch?filter=in-progress">In Progress</Link>
            </li>
            <li>
              <Link to="/batch?filter=completed">Completed</Link>
            </li>
            <li>
              <Link to="/batch?filter=commonly-used">Commonly Used</Link>
            </li>
          </ul>
        </li>

        <li
          className={
            'app-nav-dropdown ' +
            (isActive(null, 'templates') ? 'active ' : '') +
            (openDropdown === 'templates' ? 'open' : '')
          }
        >
          <button
            type="button"
            className="app-nav-item app-nav-dropdown-trigger"
            aria-expanded={openDropdown === 'templates'}
            aria-haspopup="true"
            onClick={(e) => {
              e.stopPropagation()
              toggle('templates')
            }}
          >
            <DocumentDuplicateIcon className="app-nav-item-icon" aria-hidden />
            <span className="app-nav-item-label">Templates</span>
            <span className="app-nav-arrow" aria-hidden>
              ▾
            </span>
          </button>
          <ul className="app-nav-dropdown-menu">
            <li>
              <Link to="/templates/upload">Upload new template</Link>
            </li>
            <li>
              <Link to="/templates">View all Templates</Link>
            </li>
          </ul>
        </li>

        <li className={isActive(null, 'forms') ? 'active' : ''}>
          <Link to="/forms" className="app-nav-item app-nav-link" onClick={closeDropdowns}>
            <ClipboardDocumentListIcon className="app-nav-item-icon" aria-hidden />
            <span className="app-nav-item-label">Batch Record Forms</span>
          </Link>
        </li>

        <li className={isActive(null, 'data-search') ? 'active' : ''}>
          <Link to="/data-search" className="app-nav-item app-nav-link" onClick={closeDropdowns}>
            <MagnifyingGlassIcon className="app-nav-item-icon" aria-hidden />
            <span className="app-nav-item-label">Data Search</span>
          </Link>
        </li>

        <li className={isActive(null, 'active-users') ? 'active' : ''}>
          <Link to="/active-users" className="app-nav-item app-nav-link" onClick={closeDropdowns}>
            <UsersIcon className="app-nav-item-icon" aria-hidden />
            <span className="app-nav-item-label">User admin</span>
          </Link>
        </li>
      </ul>

      <div className="app-nav-footer">
        <button
          type="button"
          className="app-nav-collapse-btn"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="app-nav-links"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRightIcon className="app-nav-collapse-icon" aria-hidden />
          ) : (
            <ChevronLeftIcon className="app-nav-collapse-icon" aria-hidden />
          )}
        </button>
      </div>
    </aside>
  )
}
