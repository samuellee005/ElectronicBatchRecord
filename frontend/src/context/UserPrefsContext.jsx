import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getUserPreferences, saveUserPreferences } from '../api/client'

const UserPrefsContext = createContext(null)

/** Bootstrap key so prefs API knows which row to load (same as previous local-only name). */
export const USER_KEY_LS = 'ebrUserDisplayName'

const LEGACY_KEYS = [
  'ebrDashboardOrder',
  'ebrDashboardHidden',
  'ebrFavorites',
  'ebrFormLastSeen',
  'ebrFavoriteResolved',
  'ebrRecentlyUsed',
  'fb-properties-panel-width',
  'ebrSidebarCollapsed',
]

function collectLegacyFromLocalStorage() {
  const out = {}
  try {
    const order = localStorage.getItem('ebrDashboardOrder')
    if (order) {
      const p = JSON.parse(order)
      if (Array.isArray(p)) out.ebrDashboardOrder = p
    }
    const hidden = localStorage.getItem('ebrDashboardHidden')
    if (hidden) {
      const p = JSON.parse(hidden)
      if (Array.isArray(p)) out.ebrDashboardHidden = p
    }
    const fav = localStorage.getItem('ebrFavorites')
    if (fav) {
      const p = JSON.parse(fav)
      if (Array.isArray(p)) out.ebrFavorites = p
    }
    const lastSeen = localStorage.getItem('ebrFormLastSeen')
    if (lastSeen) {
      const p = JSON.parse(lastSeen)
      if (p && typeof p === 'object' && !Array.isArray(p)) out.ebrFormLastSeen = p
    }
    const resolved = localStorage.getItem('ebrFavoriteResolved')
    if (resolved) {
      const p = JSON.parse(resolved)
      if (p && typeof p === 'object' && !Array.isArray(p)) out.ebrFavoriteResolved = p
    }
    const recent = localStorage.getItem('ebrRecentlyUsed')
    if (recent) {
      const p = JSON.parse(recent)
      if (Array.isArray(p)) out.ebrRecentlyUsed = p
    }
    const w = localStorage.getItem('fb-properties-panel-width')
    if (w) out['fb-properties-panel-width'] = w
    const side = localStorage.getItem('ebrSidebarCollapsed')
    if (side === '1' || side === '0') out.ebrSidebarCollapsed = side === '1'
  } catch {
    // ignore
  }
  return out
}

function clearLegacyFromLocalStorage() {
  for (const k of LEGACY_KEYS) {
    try {
      localStorage.removeItem(k)
    } catch {
      // ignore
    }
  }
}

export function getStoredUserKey() {
  try {
    return (localStorage.getItem(USER_KEY_LS) || '').trim()
  } catch {
    return ''
  }
}

function syncUserKeyToLocalStorage(next) {
  const n = next.ebrUserDisplayName
  if (typeof n === 'string' && n.trim() !== '') {
    try {
      localStorage.setItem(USER_KEY_LS, n.trim())
    } catch {
      // ignore
    }
  }
}

export function UserPrefsProvider({ children }) {
  const [prefs, setPrefsState] = useState({})
  const [ready, setReady] = useState(false)
  const saveTimer = useRef(null)

  const flushSave = useCallback((userKey, nextPrefs) => {
    if (!userKey) return
    saveUserPreferences({ userKey, prefs: nextPrefs })
      .then(() => {
        clearLegacyFromLocalStorage()
      })
      .catch(() => {})
  }, [])

  const scheduleSave = useCallback(
    (userKey, nextPrefs) => {
      if (!userKey) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => flushSave(userKey, nextPrefs), 450)
    },
    [flushSave],
  )

  const updatePrefs = useCallback(
    (patch) => {
      setPrefsState((prev) => {
        const next = { ...prev, ...patch }
        syncUserKeyToLocalStorage(next)
        const k = getStoredUserKey()
        if (k) scheduleSave(k, next)
        return next
      })
    },
    [scheduleSave],
  )

  const mergePrefs = useCallback(
    (updater) => {
      setPrefsState((prev) => {
        const next = updater(prev)
        syncUserKeyToLocalStorage(next)
        const k = getStoredUserKey()
        if (k) scheduleSave(k, next)
        return next
      })
    },
    [scheduleSave],
  )

  useEffect(() => {
    let cancelled = false
    const bootstrap = async () => {
      const legacy = collectLegacyFromLocalStorage()
      const userKey = getStoredUserKey()

      if (!userKey) {
        if (Object.keys(legacy).length) {
          setPrefsState(legacy)
        }
        if (!cancelled) setReady(true)
        return
      }

      try {
        const res = await getUserPreferences(userKey)
        if (cancelled) return
        const server = res.prefs && typeof res.prefs === 'object' && !Array.isArray(res.prefs) ? res.prefs : {}
        const merged = { ...server }
        let addedFromLegacy = false
        for (const [k, v] of Object.entries(legacy)) {
          if (merged[k] === undefined) {
            merged[k] = v
            addedFromLegacy = true
          }
        }
        setPrefsState(merged)
        if (addedFromLegacy) {
          await saveUserPreferences({ userKey, prefs: merged })
          clearLegacyFromLocalStorage()
        }
      } catch {
        if (!cancelled) setPrefsState(legacy)
      } finally {
        if (!cancelled) setReady(true)
      }
    }
    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(
    () => ({
      prefs,
      ready,
      updatePrefs,
      mergePrefs,
      getStoredUserKey,
    }),
    [prefs, ready, updatePrefs, mergePrefs],
  )

  return <UserPrefsContext.Provider value={value}>{children}</UserPrefsContext.Provider>
}

export function useUserPrefs() {
  const v = useContext(UserPrefsContext)
  if (!v) {
    throw new Error('useUserPrefs must be used within UserPrefsProvider')
  }
  return v
}
