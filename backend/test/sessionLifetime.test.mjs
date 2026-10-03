import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import cookieParser from 'cookie-parser'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-session-life-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)

const { setCredentials, getSessionVersion } = await import('../lib/authStore.mjs')
const { issueToken, verifyToken, SESSION_COOKIE_NAME } = await import('../lib/sessionToken.mjs')
const { requireAuth } = await import('../lib/requireAuth.mjs')

await setCredentials('owner', 'correct horse battery')

const DAY = 24 * 60 * 60 * 1000
const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset
test.after(() => {
  Date.now = realNow
})

async function withServer(fn) {
  const app = express()
  app.use(cookieParser())
  app.use(requireAuth())
  app.get('/api/ping', (req, res) => res.json({ user: req.session.user }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function ping(base, token) {
  const res = await fetch(`${base}/api/ping`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  })
  const set = res.headers.get('set-cookie')
  const refreshed = set?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] || null
  return { status: res.status, refreshed }
}

test('a session kept alive by refreshes still ends 90 days after login', async () => {
  offset = 0
  let token = issueToken({ user: 'owner', sv: await getSessionVersion() })
  const loginAt = verifyToken(token).authAt
  await withServer(async (base) => {
    // Use it every 8 days: each request refreshes the cookie.
    for (offset = 8 * DAY; offset < 89 * DAY; offset += 8 * DAY) {
      const r = await ping(base, token)
      assert.equal(r.status, 200, `still signed in after ${offset / DAY} days`)
      assert.ok(r.refreshed, 'the cookie is refreshed')
      assert.equal(verifyToken(r.refreshed).authAt, loginAt)
      token = r.refreshed
    }
    offset = 90 * DAY + 1000
    assert.equal((await ping(base, token)).status, 401)
  })
})

test('tokens issued before authAt existed count from when they were issued', async () => {
  offset = 0
  const legacy = issueToken({ user: 'owner', sv: await getSessionVersion(), authAt: undefined })
  const issuedAt = verifyToken(legacy).iat
  assert.equal(verifyToken(legacy).authAt, undefined)
  await withServer(async (base) => {
    offset = 8 * DAY
    const r = await ping(base, legacy)
    assert.equal(r.status, 200)
    assert.equal(verifyToken(r.refreshed).authAt, issuedAt)
  })
})
