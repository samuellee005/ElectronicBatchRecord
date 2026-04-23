/**
 * Local development only: skip the sign-in flow and use a mock user in AuthContext.
 * Set `VITE_AUTH_BYPASS=1` in `frontend/.env.development` (Vite dev server only) or
 * one-off: `VITE_AUTH_BYPASS=1 npm run dev`
 * Production builds never enable this (`import.meta.env.DEV` is false).
 */
export function isViteAuthBypass() {
  try {
    if (import.meta.env.DEV !== true) return false
    const v = import.meta.env.VITE_AUTH_BYPASS
    return v === '1' || v === 'true'
  } catch {
    return false
  }
}

export const VITE_BYPASS_USER = {
  id: 'dev-bypass',
  username: 'dev',
  displayName: 'Local dev (sign-in bypassed)',
  role: 'admin',
}
