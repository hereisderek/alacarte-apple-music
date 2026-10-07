import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-auth-state-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)
const { setCredentials, bumpSessionVersion, getSessionVersion } = await import('../lib/authStore.mjs')
const { issueToken, SESSION_COOKIE_NAME } = await import('../lib/sessionToken.mjs')
const { authRouter } = await import('../routes/auth.mjs')

await setCredentials('owner', 'correct horse battery')

async function state(token) {
  const app = express()
  app.use((await import('cookie-parser')).default())
  app.use('/api/auth', authRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/state`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    })
    return res.json()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('a session revoked by sign out everywhere is not reported as signed in', async () => {
  const token = issueToken({ user: 'owner', sv: await getSessionVersion() })
  const before = await state(token)
  assert.equal(before.authed, true)
  assert.equal(before.username, 'owner')

  await bumpSessionVersion()
  const after = await state(token)
  assert.equal(after.authed, false)
  assert.equal(after.username, null)

  const fresh = issueToken({ user: 'owner', sv: await getSessionVersion() })
  assert.equal((await state(fresh)).authed, true)
})
