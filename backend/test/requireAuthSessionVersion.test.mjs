import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import cookieParser from 'cookie-parser'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-require-sv-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)
const { setCredentials, bumpSessionVersion, clearPassword, authFilePath } = await import('../lib/authStore.mjs')
const { issueToken, SESSION_COOKIE_NAME } = await import('../lib/sessionToken.mjs')
const { requireAuth } = await import('../lib/requireAuth.mjs')

await setCredentials('owner', 'correct horse battery')

// Count reads of auth.json made while serving requests.
let authReads = 0
const realReadFile = fsp.readFile
fsp.readFile = function (file, ...rest) {
  if (String(file) === authFilePath()) authReads++
  return realReadFile.call(this, file, ...rest)
}
test.after(() => {
  fsp.readFile = realReadFile
})

let base
let server
test.before(async () => {
  const app = express()
  app.use(cookieParser())
  app.use(requireAuth())
  app.get('/api/ping', (_req, res) => res.json({ ok: true }))
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(() => new Promise((resolve) => server.close(resolve)))

const ping = (token) =>
  fetch(`${base}/api/ping`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }).then((r) => r.status)

test('the session version is read from disk once, not on every request', async () => {
  const token = issueToken({ user: 'owner', sv: 1 })
  assert.equal(await ping(token), 200)
  authReads = 0
  for (let i = 0; i < 10; i++) assert.equal(await ping(token), 200)
  // isPasswordSet still reads auth.json once per request
  assert.equal(authReads, 10)
})

test('revoked sessions are still rejected and new ones accepted', async () => {
  const old = issueToken({ user: 'owner', sv: 1 })
  const sv = await bumpSessionVersion()
  assert.equal(await ping(old), 401)
  assert.equal(await ping(issueToken({ user: 'owner', sv })), 200)
})

test('a fresh setup after auth.json was removed starts over at version 1', async () => {
  await clearPassword()
  await setCredentials('owner', 'another long password')
  assert.equal(await ping(issueToken({ user: 'owner', sv: 1 })), 200)
})
