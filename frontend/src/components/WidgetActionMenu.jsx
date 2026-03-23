import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { EllipsisVerticalIcon } from '@heroicons/react/24/outline'
import './WidgetActionMenu.css'

/**
 * @typedef {{ label: string; to: string }} ActionLink
 * @typedef {{ label: string; onClick: () => void }} ActionButton
 * @param {{ items: (ActionLink | ActionButton)[]; ariaLabel?: string }} props
 */
export default function WidgetActionMenu({ items, ariaLabel = 'Actions' }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!items?.length) return null

  return (
    <div className="widget-action-menu" ref={wrapRef}>
      <button
        type="button"
        className="widget-action-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <EllipsisVerticalIcon className="widget-action-menu-icon" />
      </button>
      {open && (
        <ul className="widget-action-menu-dropdown" role="menu">
          {items.map((item, i) => (
            <li key={i} role="none">
              {'to' in item ? (
                <Link role="menuitem" className="widget-action-menu-item" to={item.to} onClick={() => setOpen(false)}>
                  {item.label}
                </Link>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="widget-action-menu-item"
                  onClick={() => {
                    item.onClick()
                    setOpen(false)
                  }}
                >
                  {item.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
