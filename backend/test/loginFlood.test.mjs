import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-login-flood-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)
const { setCredentials } = await import('../lib/authStore.mjs')
const { withScryptSlot } = await import('../lib/scryptSemaphore.mjs')
const { authRouter } = await import('../routes/auth.mjs')

const PASSWORD = 'correct horse battery'
await setCredentials('owner', PASSWORD)

let server
let base
test.before(async () => {
  const app = express()
  // Lets each test pretend to come from its own client IP.
  app.set('trust proxy', true)
  app.use(express.json())
  app.use('/api/auth', authRouter)
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(() => new Promise((resolve) => server.close(resolve)))

function login(ip, username, password = 'wrong password!!') {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ username, password }),
  })
}

test('changing the username on every try does not dodge the rate limit', async () => {
  const statuses = []
  for (let i = 0; i < 12; i++) {
    statuses.push((await login('10.0.0.1', `user${i}`)).status)
  }
  assert.deepEqual(statuses.slice(0, 9), Array(9).fill(401))
  assert.deepEqual(statuses.slice(9), [429, 429, 429])
  // Other clients are unaffected.
  assert.equal((await login('10.0.0.2', 'owner', PASSWORD)).status, 200)
})

test('a burst of logins is refused once the hashing queue is full', async () => {
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => login(`10.1.0.${i}`, `user${i}`).then((r) => r.status)),
  )
  assert.ok(results.includes(503), 'some attempts are turned away')
  assert.ok(results.every((s) => s === 401 || s === 503), `unexpected statuses ${results}`)
  assert.equal((await login('10.2.0.1', 'owner', PASSWORD)).status, 200, 'the owner gets in afterwards')
})

test('the scrypt queue rejects callers past its limit and keeps serving the rest', async () => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const held = Array.from({ length: 6 }, () => withScryptSlot(() => gate, { maxWaiting: 3 }).then(() => 'ok', (e) => e.code))
  // Without a cap this would wait behind the held slots forever.
  const extra = await Promise.race([
    withScryptSlot(() => 'late', { maxWaiting: 3 }).catch((e) => e.code),
    new Promise((r) => setTimeout(() => r('queued without limit'), 1000)),
  ])
  release()
  const outcomes = await Promise.all(held)
  assert.equal(extra, 'SCRYPT_BUSY')
  assert.ok(outcomes.filter((o) => o === 'ok').length >= 4)
  assert.equal(await withScryptSlot(() => 'after'), 'after')
})
