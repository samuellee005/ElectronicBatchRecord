import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { isViteAuthBypass, VITE_BYPASS_USER } from '../authDev'
import { authMe, apiLogout } from '../api/client'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState(null)

  const refresh = useCallback(async () => {
    if (isViteAuthBypass()) {
      setUser(VITE_BYPASS_USER)
      setReady(true)
      return
    }
    try {
      const res = await authMe()
      if (res.success && res.authenticated && res.user) {
        setUser(res.user)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    if (isViteAuthBypass()) {
      setUser(VITE_BYPASS_USER)
      return
    }
    try {
      await apiLogout()
    } catch {
      /* still clear local state */
    }
    setUser(null)
    try {
      localStorage.removeItem('ebrUserDisplayName')
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo(
    () => ({
      ready,
      authenticated: !!user,
      user,
      refresh,
      logout,
    }),
    [ready, user, refresh, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth must be used within AuthProvider')
  return v
}
