import { hasValidApiToken } from './apiToken.mjs'
import { isAuthDisabled } from './requireAuth.mjs'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function parseSourceHost(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).host
  } catch {
    return null
  }
}

export function originGuard() {
  return async (req, res, next) => {
    if (isAuthDisabled()) return next()
    if (!req.path.startsWith('/api/')) return next()
    if (SAFE_METHODS.has(req.method)) return next()
    // bearer tokens are not sent automatically by browsers, so no CSRF risk
    if (await hasValidApiToken(req)) return next()

    const expectedHost = req.headers.host

    const originHost = parseSourceHost(req.headers.origin)
    if (originHost && originHost === expectedHost) return next()

    const refererHost = parseSourceHost(req.headers.referer)
    if (refererHost && refererHost === expectedHost) return next()

    return res.status(403).json({ error: 'forbidden origin' })
  }
}
