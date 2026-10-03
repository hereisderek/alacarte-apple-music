import { hasValidApiToken } from './apiToken.mjs'
import {
  getSessionVersion,
  isPasswordSet,
  onSessionVersionBumped,
} from './authStore.mjs'
import {
  buildSessionCookieName,
  buildSessionCookieOptions,
  getRequestSessionToken,
  issueToken,
  isSecureRequest,
  sessionAuthAt,
  shouldRefresh,
  verifyToken,
} from './sessionToken.mjs'

const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').trim().toLowerCase() === 'true'
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000

// Loaded from auth.json on first use and kept current by the bump listener.
let cachedSessionVersion = null

onSessionVersionBumped((nextSv) => {
  if (Number.isInteger(nextSv) && nextSv > 0) {
    cachedSessionVersion = nextSv
  }
})

export function isAuthDisabled() {
  return AUTH_DISABLED
}

// Routes that must remain reachable without a valid session so the
// frontend can bootstrap (state probe, initial setup, login).
// defense-in-depth: requireAuth runs after authRouter, but if mount order
// ever changes, these still need to bypass the gate.
const ALWAYS_PUBLIC = new Set([
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
])

export function requireAuth() {
  return async (req, res, next) => {
    if (AUTH_DISABLED) return next()
    if (!req.path.startsWith('/api/')) return next()
    if (ALWAYS_PUBLIC.has(req.path)) return next()
    if (await hasValidApiToken(req)) return next()

    let passwordSet
    try {
      passwordSet = await isPasswordSet()
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
    if (!passwordSet) {
      return res.status(401).json({ error: 'auth not configured', needsSetup: true })
    }

    const token = getRequestSessionToken(req)
    const payload = verifyToken(token)
    if (!payload) {
      return res.status(401).json({ error: 'unauthorized' })
    }

    // Trust the cached sv; only re-read disk before it was first loaded or
    // when the token looks stale (auth.json may have been recreated by a
    // fresh setup, which starts over at 1).
    const tokenSv = payload.sv || 1
    if (cachedSessionVersion === null || tokenSv < cachedSessionVersion) {
      const diskSv = await getSessionVersion()
      cachedSessionVersion = diskSv
      if (tokenSv < diskSv) {
        return res.status(401).json({ error: 'unauthorized' })
      }
    }

    // verifyToken already rejects sessions past the absolute limit; the
    // refreshed token keeps the original authAt so that limit still holds.
    if (shouldRefresh(payload, REFRESH_AFTER_MS)) {
      const secure = isSecureRequest(req)
      const refreshed = issueToken({
        user: payload.user,
        sv: payload.sv,
        authAt: sessionAuthAt(payload),
      })
      res.cookie(
        buildSessionCookieName(secure),
        refreshed,
        buildSessionCookieOptions({ secure }),
      )
    }

    req.session = payload
    next()
  }
}
