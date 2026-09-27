import crypto from 'node:crypto'

// Simple shared-credential gate for the public importer, deliberately
// smaller than the main backend's authStore.mjs/sessionToken.mjs: one
// username/password pair from env vars (not a setup flow with an on-disk
// store), because this is a single "front door" for a public tool, not a
// multi-user owner account. Toggle with AUTH_ENABLED.
const AUTH_ENABLED = String(process.env.AUTH_ENABLED || '').trim().toLowerCase() === 'true'
const USERNAME = process.env.IMPORTER_USERNAME || 'import'
const PASSWORD = process.env.IMPORTER_PASSWORD || ''
const SESSION_SECRET = process.env.IMPORTER_SESSION_SECRET || process.env.INTERNAL_API_KEY || ''
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'importer_session'

export function isAuthEnabled() {
  return AUTH_ENABLED
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function verifyCredentials(username, password) {
  if (!AUTH_ENABLED) return true
  if (!PASSWORD) return false
  return timingSafeEqualStr(username || '', USERNAME) && timingSafeEqualStr(password || '', PASSWORD)
}

function sign(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(json).digest('base64url')
  return `${json}.${sig}`
}

function verify(token) {
  if (!token || typeof token !== 'string') return null
  const [json, sig] = token.split('.')
  if (!json || !sig) return null
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(json).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8'))
    if (!payload?.exp || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function issueSessionToken() {
  return sign({ exp: Date.now() + SESSION_TTL_MS })
}

export function requireImporterAuth() {
  return (req, res, next) => {
    if (!AUTH_ENABLED) return next()
    if (req.path === '/api/auth/login' || req.path === '/api/auth/state') return next()
    const payload = verify(req.cookies?.[SESSION_COOKIE])
    if (!payload) return res.status(401).json({ error: 'unauthorized' })
    next()
  }
}
