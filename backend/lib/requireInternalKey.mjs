import crypto from 'node:crypto'

// Guards the /api/internal/* surface used by the separate public import
// service (see importer/). Mounted before originGuard/requireAuth in
// server.mjs so it never depends on the owner's session cookie.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || ''

export function requireInternalKey() {
  return (req, res, next) => {
    if (!INTERNAL_API_KEY) {
      return res.status(503).json({ error: 'INTERNAL_API_KEY not configured' })
    }
    const provided = Buffer.from(String(req.headers['x-internal-key'] || ''), 'utf8')
    const expected = Buffer.from(INTERNAL_API_KEY, 'utf8')
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    next()
  }
}
