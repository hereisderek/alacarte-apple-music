import crypto from 'node:crypto'

let setupToken = null

export function generateSetupToken() {
  setupToken = crypto.randomBytes(32).toString('hex')
  console.log(`[auth] one-time setup token: ${setupToken}  (use it in the X-Setup-Token header)`)
  return setupToken
}

// Setup always needs a token. When none is pending (e.g. auth.json was
// removed while the server was running) a new one is generated and logged.
export function ensureSetupToken() {
  return setupToken || generateSetupToken()
}

// Checks the candidate without using it up, so a setup that fails to save
// the credentials can be retried with the same token.
export function checkSetupToken(candidate) {
  if (!setupToken || typeof candidate !== 'string') return false
  const a = Buffer.from(candidate.trim())
  const b = Buffer.from(setupToken)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function consumeSetupToken() {
  setupToken = null
}

export function clearSetupToken() {
  setupToken = null
}
