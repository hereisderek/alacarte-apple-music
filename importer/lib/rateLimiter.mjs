// Per-key sliding-window limiter, adapted from the main backend's
// lib/loginLimiter.mjs for general public-endpoint throttling (this service
// has no equivalent to that file otherwise, since it isn't gating a login
// form with the same soft/hard-lockout shape).
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20
const SWEEP_MS = 60_000
const IDLE_EVICT_MS = 10 * 60_000

const buckets = new Map()

function trim(bucket, now) {
  bucket.hits = bucket.hits.filter((t) => now - t <= WINDOW_MS)
  bucket.lastSeen = now
}

export function createRateLimiter({ windowMs = WINDOW_MS, max = MAX_PER_WINDOW } = {}) {
  return function rateLimiter(req, res, next) {
    const key = req.ip || 'unknown'
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { hits: [], lastSeen: now }
      buckets.set(key, bucket)
    }
    trim(bucket, now)
    if (bucket.hits.length >= max) {
      const retryAfterSec = Math.max(1, Math.ceil(windowMs / 1000))
      res.set('Retry-After', String(retryAfterSec))
      return res.status(429).json({ error: 'too many requests, slow down' })
    }
    bucket.hits.push(now)
    next()
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets.entries()) {
    trim(bucket, now)
    if (bucket.hits.length === 0 && now - bucket.lastSeen > IDLE_EVICT_MS) {
      buckets.delete(key)
    }
  }
}, SWEEP_MS).unref()
