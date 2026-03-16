import { useState, useRef, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import './Nav.css'

export default function Nav() {
  const location = useLocation()
  const [openDropdown, setOpenDropdown] = useState(null)
  const navRef = useRef(null)

  const isActive = (path, match) => {
    if (match === 'batch') return location.pathname === '/batch'
    if (match === 'templates') return location.pathname.startsWith('/templates')
    if (match === 'forms') return location.pathname.startsWith('/forms') && !location.pathname.startsWith('/forms/build')
    if (match === 'home') return location.pathname === '/'
    return false
  }

  useEffect(() => {
    function handleClickOutside(e) {
      if (navRef.current && !navRef.current.contains(e.target)) setOpenDropdown(null)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  const toggle = (key) => {
    setOpenDropdown((prev) => (prev === key ? null : key))
  }

  return (
    <nav className="app-nav" ref={navRef}>
      <Link to="/" className="nav-logo">Electronic Batch Record</Link>
      <ul className="nav-links">
        <li className={'nav-dropdown ' + (isActive(null, 'batch') ? 'active ' : '') + (openDropdown === 'batch' ? 'open' : '')}>
          <button
            type="button"
            className="nav-dropdown-trigger"
            aria-expanded={openDropdown === 'batch'}
            aria-haspopup="true"
            onClick={(e) => { e.stopPropagation(); toggle('batch') }}
          >
            Batch Record <span className="nav-arrow">▾</span>
          </button>
          <ul className="nav-dropdown-menu">
            <li><Link to="/batch?filter=in-progress" onClick={() => setOpenDropdown(null)}>In Progress</Link></li>
            <li><Link to="/batch?filter=completed" onClick={() => setOpenDropdown(null)}>Completed</Link></li>
            <li><Link to="/batch?filter=commonly-used" onClick={() => setOpenDropdown(null)}>Commonly Used</Link></li>
          </ul>
        </li>
        <li className={'nav-dropdown ' + (isActive(null, 'templates') ? 'active ' : '') + (openDropdown === 'templates' ? 'open' : '')}>
          <button
            type="button"
            className="nav-dropdown-trigger"
            aria-expanded={openDropdown === 'templates'}
            aria-haspopup="true"
            onClick={(e) => { e.stopPropagation(); toggle('templates') }}
          >
            Templates <span className="nav-arrow">▾</span>
          </button>
          <ul className="nav-dropdown-menu">
            <li><Link to="/templates/upload" onClick={() => setOpenDropdown(null)}>Upload new template</Link></li>
            <li><Link to="/templates" onClick={() => setOpenDropdown(null)}>View all Templates</Link></li>
          </ul>
        </li>
        <li className={isActive(null, 'forms') ? 'active' : ''}>
          <Link to="/forms">Batch Record Forms</Link>
        </li>
      </ul>
    </nav>
  )
}
