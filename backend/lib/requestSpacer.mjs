// Serializes calls through one FIFO queue and enforces a minimum gap between
// dispatch times, regardless of how long each call takes. Built for
// /api/internal/search (see routes/internal.mjs): a batch import can fire
// dozens of Apple catalog searches back-to-back, which trips Apple's
// anonymous rate limit in well under a minute (confirmed against a real
// backend — a 24-track import produced twelve 429s with no spacing at all).
// This is the primary defense; importer/lib/backendClient.mjs's client-side
// 429 retry is the fallback for whatever this doesn't fully absorb.
export function createSpacer(minIntervalMs) {
  let queue = Promise.resolve()
  let lastRunAt = 0

  return function run(fn) {
    const result = queue.then(async () => {
      const wait = lastRunAt + minIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastRunAt = Date.now()
      return fn()
    })
    // Keep the chain alive even if a call throws — one failed search must
    // not wedge every search behind it.
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
