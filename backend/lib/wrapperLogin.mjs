import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'
import {
  buildFailureTail,
  extractWrapperFailureReason,
  formatUnexpectedExitFallback,
  logsIndicateTwoFa,
  redactWrapperOutput,
  TWO_FA_HINT,
} from './wrapperLoginDiagnostics.mjs'

const WRAPPER_DATA_IN_WEB = '/wrapper-data'
const WRAPPER_2FA_HOST_PATH = path.join(
  WRAPPER_DATA_IN_WEB,
  'data',
  'com.apple.android.music',
  'files',
  '2fa.txt',
)

function getSupervisorUrl() {
  const host = process.env.AMDL_WRAPPER_HOST || '127.0.0.1'
  const port = process.env.AMDL_WRAPPER_SUPERVISOR_PORT || 40020
  return `http://${host}:${port}`
}

const REACHABILITY_ERROR =
  "The initial Apple transport check failed. Check DNS, firewall, VPN or proxy routing, and Apple's service status before retrying."

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function validateEmail(e) {
  if (typeof e !== 'string' || e.length < 3 || e.length > 320) return false
  return EMAIL_RE.test(e)
}
function validatePassword(p) {
  return passwordValidationError(p) == null
}

function passwordValidationError(p) {
  if (typeof p !== 'string' || p.length < 1 || p.length > 512) return 'Invalid password'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p)) return 'Invalid password'
  return null
}
function validate2faCode(c) {
  return typeof c === 'string' && /^\d{6}$/.test(c.trim())
}

export { validate2faCode }

let active = null
let hardBlockReason = null

function resetActive() {
  active = null
}

export function clearHardBlock() {
  hardBlockReason = null
}

export function getHardBlock() {
  return hardBlockReason
}

function emitStatus(patch) {
  if (!active) return
  active.status = { ...active.status, ...patch, ts: Date.now() }
  emitEvent('wrapper.login', active.status)
}

async function writeCodeAtomicallyToHostMount(code) {
  const dir = path.dirname(WRAPPER_2FA_HOST_PATH)
  await fsp.mkdir(dir, { recursive: true })
  const tmpPath = path.join(dir, `.2fa.txt.${process.pid}.${Date.now()}.tmp`)
  try {
    await fsp.writeFile(tmpPath, code, { mode: 0o600, encoding: 'utf8' })
    await fsp.rename(tmpPath, WRAPPER_2FA_HOST_PATH)
  } finally {
    try {
      await fsp.unlink(tmpPath)
    } catch {
      /* ignore */
    }
  }
}

// Once 2FA starts we are waiting on the user, not on Apple. Cover the
// wrapper's extended code-entry window (4 minutes) with a generous margin.
const TWO_FA_WINDOW_MS = 10 * 60_000

function markTwoFaDetected() {
  if (!active || active.twoFaDetected) return
  active.twoFaDetected = true
  clearTimeout(active.overallTimeout)
  active.overallTimeout = setTimeout(() => {
    if (active && !active.terminated) {
      finalizeFailure('Timed out waiting for the 2FA code')
    }
  }, TWO_FA_WINDOW_MS)
  emitStatus({ phase: '2fa-required', hint: TWO_FA_HINT })
}

export function getLoginStatus() {
  if (!active) return { inProgress: false }
  return {
    inProgress: true,
    status: active.status,
  }
}

export async function isWrapperReachable() {
  try {
    const res = await fetch(`${getSupervisorUrl()}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.ok)
  } catch {
    return false
  }
}

// Kept for backward compatibility with existing routes/tests
export const isDockerReachable = isWrapperReachable

async function checkAppleReachability() {
  try {
    const res = await fetch('https://buy.itunes.apple.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    })
    return res.status < 500
  } catch {
    return false
  }
}

export function startWrapperLogin({ email, password }) {
  if (active) {
    return Promise.reject(new Error('A sign-in is already in progress'))
  }
  if (hardBlockReason) {
    return Promise.reject(
      new Error(
        `${hardBlockReason} Retrying now will only deepen the lockout. Reset the password at iforgot.apple.com, sign in once on a real Apple device, then clear and re-enter credentials here.`,
      ),
    )
  }
  if (!validateEmail(email)) {
    return Promise.reject(new Error('Invalid email format'))
  }
  if (!validatePassword(password)) {
    return Promise.reject(new Error(passwordValidationError(password) || 'Invalid password'))
  }

  active = {
    email,
    password,
    collected: '',
    twoFaDetected: false,
    twoFaSubmitted: false,
    status: { phase: 'preparing' },
    promise: null,
    resolve: null,
    reject: null,
    abortController: new AbortController(),
    terminated: false,
  }

  const promise = new Promise((resolve, reject) => {
    active.resolve = resolve
    active.reject = reject
  })
  active.promise = promise

  runLoginFlow().catch((err) => {
    try {
      finalizeFailure(err.message || String(err))
    } catch {}
  })

  return promise
}

async function runLoginFlow() {
  const current = active
  emitStatus({ phase: 'preparing' })
  emitStatus({ phase: 'checking-network' })
  const reachable = await checkAppleReachability()
  if (!reachable) {
    await finalizeFailure(REACHABILITY_ERROR, current)
    return
  }

  emitStatus({ phase: 'signing-in' })

  if (!current.twoFaDetected) {
    current.overallTimeout = setTimeout(() => {
      if (current && !current.terminated) {
        finalizeFailure('Sign-in timed out', current)
      }
    }, 180_000)
  }

  let res
  try {
    res = await fetch(`${getSupervisorUrl()}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: current.email, password: current.password }),
      signal: current.abortController.signal,
    })
  } catch (err) {
    if (current && !current.terminated) {
      await finalizeFailure(`Cannot reach wrapper supervisor: ${err.message}`, current)
    }
    return
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    await finalizeFailure(errText || `Wrapper sign-in failed (HTTP ${res.status})`, current)
    return
  }

  const reader = res.body.getReader()
  current.reader = reader
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!current || current.terminated || active !== current) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!current || current.terminated || active !== current) break
        const redacted = redactWrapperOutput(line + '\n', current.email, current.password)
        current.collected += redacted
        emitEvent('wrapper.login.log', { line: redacted.trim().slice(0, 500) })
        checkCollected(current)
      }
    }

    if (buffer.length > 0 && current && !current.terminated && active === current) {
      const redacted = redactWrapperOutput(buffer + '\n', current.email, current.password)
      current.collected += redacted
      emitEvent('wrapper.login.log', { line: redacted.trim().slice(0, 500) })
      checkCollected(current)
    }
  } catch (err) {
    if (current && !current.terminated && err.name !== 'AbortError') {
      console.error('[wrapper-login] error reading supervisor stream:', err)
    }
  }

  if (current && !current.terminated && active === current) {
    handleStreamFinished(current)
  }
}

function checkCollected(current = active) {
  if (!current || current.terminated) return
  const s = current.collected

  if (!current.twoFaDetected && logsIndicateTwoFa(s)) {
    markTwoFaDetected()
  }

  if (/account info cached successfully/i.test(s)) {
    finalizeSuccess(current).catch((e) => finalizeFailure(e.message, current))
  }
}

function handleStreamFinished(current = active) {
  if (!current || current.terminated) return
  if (/account info cached successfully/i.test(current.collected)) {
    finalizeSuccess(current).catch((e) => finalizeFailure(e.message, current))
    return
  }

  let reason = extractWrapperFailureReason(current.collected)
  if (!reason) {
    reason = formatUnexpectedExitFallback({
      statusCode: 0,
      twoFaDetected: current.twoFaDetected,
      twoFaSubmitted: current.twoFaSubmitted,
    })
  } else if (/disabled|locked/i.test(reason)) {
    hardBlockReason = reason
  }

  finalizeFailure(reason, current)
}

async function finalizeSuccess(target = active) {
  if (!target || target.terminated) return
  target.terminated = true
  clearTimeout(target.overallTimeout)
  try {
    target.reader?.cancel().catch(() => {})
  } catch {}
  emitStatus({ phase: 'ready' })
  const resolve = target.resolve
  if (active === target) resetActive()
  resolve?.({ ok: true })
}

async function finalizeFailure(reason, target = active) {
  if (!target || target.terminated) return
  target.terminated = true
  clearTimeout(target.overallTimeout)
  try {
    target.reader?.cancel().catch(() => {})
  } catch {}
  const tail = buildFailureTail(target?.collected || '')
  console.error(
    `[wrapper-login] failed: ${reason}\n--- wrapper output (tail, redacted) ---\n${tail.join('\n')}`,
  )
  emitStatus({ phase: 'failed', error: reason, tail })
  const reject = target.reject
  if (active === target) resetActive()
  reject?.(new Error(reason))
}

export async function submit2FA(code) {
  if (!active) throw new Error('No sign-in in progress')
  if (!active.twoFaDetected) {
    throw new Error('No 2FA prompt has been seen for this sign-in')
  }
  if (active.twoFaSubmitted) {
    throw new Error('2FA code already submitted for this sign-in')
  }
  if (!validate2faCode(code)) {
    throw new Error('Code must be exactly 6 digits')
  }
  active.twoFaSubmitted = true

  const safe = String(code).trim()

  // First notify supervisor via HTTP
  try {
    const res = await fetch(`${getSupervisorUrl()}/login/2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: safe }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(errText || `Supervisor rejected 2FA submission (HTTP ${res.status})`)
    }
  } catch (err) {
    // If supervisor endpoint fails, attempt writing to shared volume if present
    if (wrapperDataMountExists()) {
      await writeCodeAtomicallyToHostMount(safe)
    } else {
      throw err
    }
  }

  // Also write to shared volume if mounted for maximum reliability
  if (wrapperDataMountExists()) {
    try {
      await writeCodeAtomicallyToHostMount(safe)
    } catch {
      /* ignore */
    }
  }

  emitStatus({ phase: 'verifying-2fa' })
  return { ok: true }
}

export async function cancelLogin() {
  if (!active) return { ok: true, noop: true }
  try {
    await fetch(`${getSupervisorUrl()}/login/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    /* ignore */
  }
  if (active.abortController) {
    active.abortController.abort()
  }
  await finalizeFailure('Cancelled')
  return { ok: true }
}

export function wrapperDataMountExists() {
  try {
    return fs.statSync(WRAPPER_DATA_IN_WEB).isDirectory()
  } catch {
    return false
  }
}
