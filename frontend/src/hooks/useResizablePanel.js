import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Drag-to-resize width for a sidebar, saved to user prefs when the drag ends.
 *
 * `side` is the screen edge the panel sits on: a 'left' panel grows as the
 * pointer moves right, a 'right' panel grows as it moves left. The width is
 * clamped to [minW, maxW] and to `maxViewportFraction` of the window so a
 * panel can never swallow the whole canvas.
 */
export default function useResizablePanel({
  side,
  defaultW,
  minW,
  maxW,
  maxViewportFraction = 0.7,
  prefKey,
  prefs,
  updatePrefs,
  disabled = false,
}) {
  const [width, setWidthState] = useState(defaultW)
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(defaultW)
  const dragRef = useRef({ active: false, startX: 0, startW: defaultW })

  const clamp = useCallback(
    (w) => {
      const viewportMax =
        typeof window !== 'undefined' ? Math.floor(window.innerWidth * maxViewportFraction) : maxW
      const hi = Math.max(minW, Math.min(maxW, viewportMax))
      return Math.min(hi, Math.max(minW, Math.round(w)))
    },
    [minW, maxW, maxViewportFraction],
  )

  const applyWidth = useCallback(
    (w) => {
      const next = clamp(w)
      widthRef.current = next
      setWidthState(next)
      return next
    },
    [clamp],
  )

  /** Set the width programmatically (e.g. an Expand button) and save it. */
  const setWidth = useCallback(
    (w) => {
      const next = applyWidth(w)
      if (prefKey) updatePrefs({ [prefKey]: String(next) })
    },
    [applyWidth, prefKey, updatePrefs],
  )

  const stored = prefKey ? prefs[prefKey] : undefined
  useEffect(() => {
    if (dragRef.current.active) return
    const n = parseInt(typeof stored === 'string' ? stored : String(stored || ''), 10)
    if (!Number.isFinite(n)) return
    applyWidth(n)
  }, [stored, applyWidth])

  const endResize = useCallback(() => {
    if (!dragRef.current.active) return
    dragRef.current.active = false
    setResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (prefKey) updatePrefs({ [prefKey]: String(widthRef.current) })
  }, [prefKey, updatePrefs])

  useEffect(() => {
    const move = (e) => {
      if (!dragRef.current.active) return
      const clientX =
        'touches' in e && e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX
      if (e.type === 'touchmove' && e.cancelable) e.preventDefault()
      const { startX, startW } = dragRef.current
      const dx = side === 'left' ? clientX - startX : startX - clientX
      applyWidth(startW + dx)
    }
    const up = () => endResize()

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', up)

    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (dragRef.current.active) {
        dragRef.current.active = false
        setResizing(false)
      }
    }
  }, [side, applyWidth, endResize])

  // Keep the panel inside the new limit when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      if (widthRef.current !== clamp(widthRef.current)) applyWidth(widthRef.current)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp, applyWidth])

  const onResizeStart = useCallback(
    (e) => {
      if (disabled) return
      e.preventDefault()
      const clientX =
        'touches' in e && e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX
      dragRef.current = { active: true, startX: clientX, startW: widthRef.current }
      setResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [disabled],
  )

  /** Arrow keys nudge the width when the handle has focus. */
  const onResizeKeyDown = useCallback(
    (e) => {
      if (disabled) return
      const step = e.shiftKey ? 64 : 16
      let delta = 0
      if (e.key === 'ArrowLeft') delta = side === 'left' ? -step : step
      else if (e.key === 'ArrowRight') delta = side === 'left' ? step : -step
      else return
      e.preventDefault()
      setWidth(widthRef.current + delta)
    },
    [disabled, side, setWidth],
  )

  return { width, setWidth, resizing, onResizeStart, onResizeKeyDown }
}
