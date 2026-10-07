import os from 'node:os'

const MAX_CONCURRENCY = Math.max(1, Math.min(2, os.cpus().length - 1))
// Each hash holds 128 MiB for a fraction of a second. Past this many waiting
// callers a flood of logins is refused instead of queueing without bound
// ahead of the real user.
const MAX_WAITING = 16

let active = 0
const queue = []

function pump() {
  while (active < MAX_CONCURRENCY && queue.length > 0) {
    const next = queue.shift()
    active += 1
    next()
  }
}

export function scryptBusyError() {
  const err = new Error('password check busy, try again shortly')
  err.code = 'SCRYPT_BUSY'
  return err
}

export async function withScryptSlot(fn, { maxWaiting = MAX_WAITING } = {}) {
  if (active >= MAX_CONCURRENCY && queue.length >= maxWaiting) {
    throw scryptBusyError()
  }
  await new Promise((resolve) => {
    queue.push(resolve)
    pump()
  })
  try {
    return await fn()
  } finally {
    active = Math.max(0, active - 1)
    pump()
  }
}
