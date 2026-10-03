import express from 'express'

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  bumpSessionVersion,
  getSessionVersion,
  getUsername,
  isPasswordSet,
  isValidUsername,
  rehashIfStale,
  setCredentials,
  setPassword,
  setUsername,
  verifyCredentials,
  verifyPassword,
} from '../lib/authStore.mjs'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_HOST_PREFIX,
  buildSessionCookieName,
  buildClearedCookieOptions,
  buildSessionCookieOptions,
  getRequestSessionToken,
  issueToken,
  verifyToken,
  isSecureRequest,
} from '../lib/sessionToken.mjs'
import { buildLoginLimiter } from '../lib/loginLimiter.mjs'
import { logAuth } from '../lib/authLog.mjs'
import {
  checkSetupToken,
  consumeSetupToken,
  ensureSetupToken,
} from '../lib/setupToken.mjs'
import { isAuthDisabled } from '../lib/requireAuth.mjs'

export const authRouter = express.Router()
const loginLimiter = buildLoginLimiter()
// Every login attempt costs a full scrypt hash whatever the username, so
// attempts are also limited per IP: rotating usernames can't buy an
// attacker fresh attempts. Looser than the per-user limit for shared IPs.
const ipLimiter = buildLoginLimiter({ softFailThreshold: 10, hardFailThreshold: 50 })

function trimStringField(v) {
  return typeof v === 'string' ? v.trim() : null
}

function rawStringField(v) {
  return typeof v === 'string' ? v : null
}

function limiterKey(req, username) {
  return `${req.ip}|${username || '?'}`
}

function ipLimiterKey(req) {
  return `${req.ip}|*`
}

function sendBusy(res) {
  res.set('Retry-After', '2')
  return res.status(503).json({ error: 'busy, try again shortly' })
}

function sendRateLimited(res, result) {
  if (typeof result.retryAfterSec === 'number') {
    res.set('Retry-After', String(result.retryAfterSec))
  }
  return res.status(429).json({
    error: 'too many attempts',
    retryAfter: result.retryAfterSec,
    lockedUntil: result.lockedUntil,
  })
}

function sessionCookieParts(req) {
  const secure = isSecureRequest(req)
  return {
    secure,
    cookieName: buildSessionCookieName(secure),
    cookieOptions: buildSessionCookieOptions({ secure }),
  }
}

// Set while a setup is saving credentials, so two requests holding the
// token can't both run setup and overwrite each other.
let setupInFlight = false

function mapValidationStatus(err) {
  if (!err?.code) return null
  if (err.code === 'INVALID_USERNAME') return 400
  if (err.code === 'WEAK_PASSWORD') return 400
  if (err.code === 'LONG_PASSWORD') return 400
  return null
}

authRouter.get('/state', async (req, res) => {
  try {
    const authDisabled = isAuthDisabled()
    const passwordSet = authDisabled ? true : await isPasswordSet()
    let authed = authDisabled
    if (passwordSet && !authDisabled) {
      const session = verifyToken(getRequestSessionToken(req))
      authed = Boolean(session)
    }
    // Only expose the username to authed requests so unauthenticated
    // probes can't enumerate it.
    const username = authed && !authDisabled ? await getUsername() : null
    res.json({
      authDisabled,
      passwordSet,
      authed,
      username,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      usernameMinLength: USERNAME_MIN_LENGTH,
      usernameMaxLength: USERNAME_MAX_LENGTH,
      requiresSetupToken: !passwordSet && !authDisabled && Boolean(ensureSetupToken()),
    })
  } catch (err) {
    res.status(500).json({ error: 'internal error' })
  }
})

authRouter.post('/setup', async (req, res) => {
  if (isAuthDisabled()) {
    return res.status(409).json({ error: 'auth is disabled' })
  }

  const key = limiterKey(req, 'setup')
  const check = loginLimiter.check(key)
  if (!check.allowed) {
    return sendRateLimited(res, check)
  }

  try {
    if (await isPasswordSet()) {
      return res.status(409).json({ error: 'already configured' })
    }

    const username = trimStringField(req.body?.username)
    const password = rawStringField(req.body?.password)
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' })
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters (letters, digits, ., _, -)`,
      })
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` })
    }

    ensureSetupToken()
    const setupToken = rawStringField(req.headers['x-setup-token'])
    if (!checkSetupToken(setupToken)) {
      const penalty = loginLimiter.recordFailure(key)
      if (penalty.status === 429) {
        return sendRateLimited(res, penalty)
      }
      return res.status(403).json({ error: 'invalid setup token' })
    }
    if (setupInFlight) {
      return res.status(409).json({ error: 'setup already in progress' })
    }

    // The token is only used up once the credentials are saved; a failed
    // save leaves it valid instead of leaving setup open to anyone.
    setupInFlight = true
    try {
      await setCredentials(username, password)
    } finally {
      setupInFlight = false
    }
    consumeSetupToken()
    const sv = await getSessionVersion()
    const token = issueToken({ user: username, sv })
    const { cookieName, cookieOptions } = sessionCookieParts(req)
    res.cookie(
      cookieName,
      token,
      cookieOptions,
    )
    loginLimiter.recordSuccess(key)
    logAuth('setup.ok', { user: username, ip: req.ip })
    res.json({ ok: true, username })
  } catch (err) {
    if (err?.code === 'SCRYPT_BUSY') return sendBusy(res)
    const status = mapValidationStatus(err)
    if (status) {
      return res.status(400).json({ error: err.message })
    }
    res.status(500).json({ error: 'internal error' })
  }
})

authRouter.post('/login', async (req, res) => {
  if (isAuthDisabled()) {
    return res.status(409).json({ error: 'auth is disabled' })
  }

  const username = trimStringField(req.body?.username) || ''
  const password = rawStringField(req.body?.password) || ''
  const key = limiterKey(req, username)
  const ipKey = ipLimiterKey(req)
  const ipCheck = ipLimiter.check(ipKey)
  const check = ipCheck.allowed ? loginLimiter.check(key) : ipCheck
  if (!check.allowed) {
    logAuth('login.locked', { user: username || null, ip: req.ip, until: check.lockedUntil || null })
    return sendRateLimited(res, check)
  }

  try {
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' })
    }
    if (!(await isPasswordSet())) {
      return res.status(409).json({ error: 'no credentials configured', needsSetup: true })
    }
    const matchedHash = await verifyCredentials(username, password)
    if (!matchedHash) {
      const ipPenalty = ipLimiter.recordFailure(ipKey)
      const userPenalty = loginLimiter.recordFailure(key)
      const penalty = userPenalty.status === 429 ? userPenalty : ipPenalty
      if (penalty.status === 429) {
        logAuth('login.locked', { user: username, ip: req.ip, until: penalty.lockedUntil || null })
        return sendRateLimited(res, penalty)
      }
      logAuth('login.fail', { user: username, ip: req.ip, reason: 'invalid_credentials' })
      return res.status(401).json({ error: 'invalid credentials' })
    }

    loginLimiter.recordSuccess(key)
    ipLimiter.recordSuccess(ipKey)

    // Transparently upgrade hash if stored with older scrypt params.
    // Fire-and-forget: non-fatal if it fails; next login retries.
    rehashIfStale(password, matchedHash).catch(() => {})

    const sv = await getSessionVersion()
    const token = issueToken({ user: username, sv })
    const { cookieName, cookieOptions } = sessionCookieParts(req)
    res.cookie(
      cookieName,
      token,
      cookieOptions,
    )
    logAuth('login.ok', { user: username, ip: req.ip })
    res.json({ ok: true, username })
  } catch (err) {
    if (err?.code === 'SCRYPT_BUSY') return sendBusy(res)
    res.status(500).json({ error: 'internal error' })
  }
})

authRouter.post('/logout', (req, res) => {
  const secure = isSecureRequest(req)
  res.cookie(
    SESSION_COOKIE_NAME,
    '',
    buildClearedCookieOptions({ secure: false }),
  )
  res.cookie(
    SESSION_COOKIE_HOST_PREFIX,
    '',
    buildClearedCookieOptions({ secure }),
  )
  res.json({ ok: true })
})

authRouter.post('/change-password', async (req, res) => {
  if (isAuthDisabled()) {
    return res.status(409).json({ error: 'auth is disabled' })
  }

  const user = typeof req.session?.user === 'string' ? req.session.user : null
  const key = limiterKey(req, user || 'unknown')
  const check = loginLimiter.check(key)
  if (!check.allowed) {
    return sendRateLimited(res, check)
  }

  try {
    const current = rawStringField(req.body?.currentPassword)
    const next = rawStringField(req.body?.newPassword)
    if (!current || !next) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' })
    }
    if (next.length < MIN_PASSWORD_LENGTH || next.length > MAX_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters` })
    }

    const sessionPayload = req.session
    if (!sessionPayload) return res.status(401).json({ error: 'unauthorized' })
    if (!(await verifyPassword(current))) {
      const penalty = loginLimiter.recordFailure(key)
      if (penalty.status === 429) {
        return sendRateLimited(res, penalty)
      }
      return res.status(401).json({ error: 'current password incorrect' })
    }

    await setPassword(next)
    loginLimiter.recordSuccess(key)
    const sv = await getSessionVersion()
    const token = issueToken({ user: sessionPayload.user, sv })
    const { cookieName, cookieOptions } = sessionCookieParts(req)
    res.cookie(
      cookieName,
      token,
      cookieOptions,
    )
    logAuth('password.changed', { user: sessionPayload.user, ip: req.ip })
    res.json({ ok: true })
  } catch (err) {
    if (err?.code === 'SCRYPT_BUSY') return sendBusy(res)
    const status = mapValidationStatus(err)
    if (status) {
      return res.status(status).json({ error: err.message })
    }
    res.status(500).json({ error: 'internal error' })
  }
})

authRouter.post('/change-username', async (req, res) => {
  if (isAuthDisabled()) {
    return res.status(409).json({ error: 'auth is disabled' })
  }

  const user = typeof req.session?.user === 'string' ? req.session.user : null
  const key = limiterKey(req, user || 'unknown')
  const check = loginLimiter.check(key)
  if (!check.allowed) {
    return sendRateLimited(res, check)
  }

  try {
    const newUsername = trimStringField(req.body?.username)
    const currentPassword = rawStringField(req.body?.currentPassword)
    if (!newUsername || !currentPassword) {
      return res.status(400).json({ error: 'username and currentPassword required' })
    }
    if (!isValidUsername(newUsername)) {
      return res.status(400).json({
        error: `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters (letters, digits, ., _, -)`,
      })
    }

    const sessionPayload = req.session
    if (!sessionPayload) return res.status(401).json({ error: 'unauthorized' })
    if (!(await verifyPassword(currentPassword))) {
      const penalty = loginLimiter.recordFailure(key)
      if (penalty.status === 429) {
        return sendRateLimited(res, penalty)
      }
      return res.status(401).json({ error: 'current password incorrect' })
    }

    await setUsername(newUsername)
    loginLimiter.recordSuccess(key)
    const sv = await getSessionVersion()
    const token = issueToken({ user: newUsername, sv })
    const { cookieName, cookieOptions } = sessionCookieParts(req)
    res.cookie(
      cookieName,
      token,
      cookieOptions,
    )
    logAuth('username.changed', { from: sessionPayload.user, to: newUsername, ip: req.ip })
    res.json({ ok: true, username: newUsername })
  } catch (err) {
    if (err?.code === 'SCRYPT_BUSY') return sendBusy(res)
    const status = mapValidationStatus(err)
    if (status) {
      return res.status(400).json({ error: err.message })
    }
    res.status(500).json({ error: 'internal error' })
  }
})

authRouter.post('/revoke-all', async (req, res) => {
  if (isAuthDisabled()) {
    return res.status(409).json({ error: 'auth is disabled' })
  }

  const user = typeof req.session?.user === 'string' ? req.session.user : null
  const key = limiterKey(req, user || 'unknown')
  const check = loginLimiter.check(key)
  if (!check.allowed) {
    return sendRateLimited(res, check)
  }

  try {
    const currentPassword = rawStringField(req.body?.currentPassword)
    if (!currentPassword) {
      return res.status(400).json({ error: 'currentPassword required' })
    }

    const sessionPayload = req.session
    if (!sessionPayload) {
      return res.status(401).json({ error: 'unauthorized' })
    }

    if (!(await verifyPassword(currentPassword))) {
      const penalty = loginLimiter.recordFailure(key)
      if (penalty.status === 429) {
        return sendRateLimited(res, penalty)
      }
      return res.status(401).json({ error: 'current password incorrect' })
    }

    const sv = await bumpSessionVersion()
    loginLimiter.recordSuccess(key)
    const token = issueToken({ user: sessionPayload.user, sv })
    const { cookieName, cookieOptions } = sessionCookieParts(req)
    res.cookie(cookieName, token, cookieOptions)
    logAuth('revoke.all', { user: sessionPayload.user, ip: req.ip })
    res.json({ ok: true })
  } catch (err) {
    if (err?.code === 'SCRYPT_BUSY') return sendBusy(res)
    res.status(500).json({ error: 'internal error' })
  }
})
