const SOFT_WINDOW_MS = 60_000
const HARD_WINDOW_MS = 15 * 60_000
const SOFT_FAIL_THRESHOLD = 5
const HARD_FAIL_THRESHOLD = 20
const HARD_LOCK_MS = 15 * 60_000
const MAX_SOFT_BACKOFF_MS = 30_000
const SWEEP_MS = 60_000
const IDLE_EVICT_MS = 30 * 60_000

function nowMs() {
  return Date.now()
}

function trim(bucket, now) {
  bucket.soft = bucket.soft.filter((t) => now - t <= SOFT_WINDOW_MS)
  bucket.hard = bucket.hard.filter((t) => now - t <= HARD_WINDOW_MS)
  bucket.lastSeen = now
}

// Each limiter keeps its own buckets and thresholds, so a looser per-IP
// limiter can sit next to the per-user one.
export function buildLoginLimiter({
  softFailThreshold = SOFT_FAIL_THRESHOLD,
  hardFailThreshold = HARD_FAIL_THRESHOLD,
} = {}) {
  const buckets = new Map()

  function getBucket(key) {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        soft: [],
        hard: [],
        backoffUntil: 0,
        lockedUntil: 0,
        lastSeen: nowMs(),
      }
      buckets.set(key, bucket)
    }
    return bucket
  }

  function computeBackoffMs(softCount) {
    if (softCount < softFailThreshold) return 0
    const exponent = Math.max(0, softCount - softFailThreshold)
    return Math.min(MAX_SOFT_BACKOFF_MS, 1000 * 2 ** exponent)
  }

  function check(key) {
    const now = nowMs()
    const bucket = getBucket(key)
    trim(bucket, now)

    if (bucket.lockedUntil > now) {
      return {
        allowed: false,
        status: 429,
        lockedUntil: bucket.lockedUntil,
        retryAfterSec: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
      }
    }

    if (bucket.backoffUntil > now) {
      return {
        allowed: false,
        status: 429,
        retryAfterSec: Math.max(1, Math.ceil((bucket.backoffUntil - now) / 1000)),
      }
    }

    return { allowed: true, status: 200 }
  }

  function recordFailure(key) {
    const now = nowMs()
    const bucket = getBucket(key)
    trim(bucket, now)

    bucket.soft.push(now)
    bucket.hard.push(now)

    if (bucket.hard.length >= hardFailThreshold) {
      bucket.lockedUntil = now + HARD_LOCK_MS
      return {
        status: 429,
        lockedUntil: bucket.lockedUntil,
        retryAfterSec: Math.max(1, Math.ceil(HARD_LOCK_MS / 1000)),
      }
    }

    const backoffMs = computeBackoffMs(bucket.soft.length)
    if (backoffMs > 0) {
      bucket.backoffUntil = now + backoffMs
      return {
        status: 429,
        retryAfterSec: Math.max(1, Math.ceil(backoffMs / 1000)),
      }
    }

    return { status: 401 }
  }

  function recordSuccess(key) {
    buckets.delete(key)
  }

  setInterval(() => {
    const now = nowMs()
    for (const [key, bucket] of buckets.entries()) {
      trim(bucket, now)
      if (
        bucket.soft.length === 0 &&
        bucket.hard.length === 0 &&
        bucket.backoffUntil <= now &&
        bucket.lockedUntil <= now &&
        now - bucket.lastSeen > IDLE_EVICT_MS
      ) {
        buckets.delete(key)
      }
    }
  }, SWEEP_MS).unref()

  return {
    check,
    recordFailure,
    recordSuccess,
  }
}
