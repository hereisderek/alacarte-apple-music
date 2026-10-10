import { getAppleCooldownMs } from './appleApi.mjs'
import { AppleRateLimitedError } from './appleGateway.mjs'

export const isAppleRateLimited = (err) =>
  err instanceof AppleRateLimitedError || /^Apple API 429\b/.test(String(err?.message || ''))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// For long-running jobs: pauses until Apple is expected to accept calls again.
// onWait(untilMs) is called when the pause starts and onWait(null) when it ends, so the
// job can show "waiting for Apple, resumes in ..." instead of failing items.
export async function waitOutRateLimit(err, { shouldStop = () => false, onWait = () => {} } = {}) {
  const seconds = Math.max(1, Number(err?.retryAfterSec) || Math.ceil(getAppleCooldownMs() / 1000) || 60)
  const until = Date.now() + seconds * 1000
  onWait(until)
  try {
    while (Date.now() < until && !shouldStop()) await sleep(Math.min(1000, until - Date.now()))
  } finally {
    onWait(null)
  }
}

// Runs fn, and while Apple is rate limiting waits it out and tries again (until
// shouldStop() says the job was cancelled). Any other error is thrown as is.
export async function withAppleRetry(fn, opts = {}) {
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isAppleRateLimited(err) || opts.shouldStop?.()) throw err
      await waitOutRateLimit(err, opts)
      if (opts.shouldStop?.()) throw err
    }
  }
}
