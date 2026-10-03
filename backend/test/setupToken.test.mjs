import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-setup-token-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)

const { generateSetupToken } = await import('../lib/setupToken.mjs')
const { authRouter } = await import('../routes/auth.mjs')

const AUTH_FILE = path.join(tmpDir, 'auth.json')
const PASSWORD = 'correct horse battery'

async function withServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function setup(base, token, username = 'owner') {
  return fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-setup-token': token } : {}),
    },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
}

test('a setup that fails to save keeps the token and does not open setup', async () => {
  const token = generateSetupToken()
  await withServer(async (base) => {
    // Make the atomic write of auth.json fail.
    await fsp.mkdir(`${AUTH_FILE}.tmp`)
    const failed = await setup(base, token)
    assert.equal(failed.status, 500)
    await fsp.rmdir(`${AUTH_FILE}.tmp`)

    const noToken = await setup(base, null, 'intruder')
    assert.equal(noToken.status, 403)

    const retry = await setup(base, token)
    assert.equal(retry.status, 200)
    assert.equal(JSON.parse(await fsp.readFile(AUTH_FILE, 'utf8')).username, 'owner')

    const again = await setup(base, token, 'intruder')
    assert.equal(again.status, 409)
  })
})

test('setup needs a token even when none was generated at boot', async () => {
  await fsp.rm(AUTH_FILE, { force: true })
  await withServer(async (base) => {
    const lines = []
    const orig = console.log
    console.log = (...args) => lines.push(args.join(' '))
    let state
    try {
      const noToken = await setup(base, null, 'intruder')
      assert.equal(noToken.status, 403)
      state = await (await fetch(`${base}/api/auth/state`)).json()
    } finally {
      console.log = orig
    }
    assert.equal(state.passwordSet, false)
    assert.equal(state.requiresSetupToken, true)
    const logged = lines.map((l) => l.match(/setup token: ([0-9a-f]{64})/)?.[1]).find(Boolean)
    assert.ok(logged, 'a new setup token is logged')
    const ok = await setup(base, logged)
    assert.equal(ok.status, 200)
  })
})

test('two setups with the same token cannot both save', async () => {
  await fsp.rm(AUTH_FILE, { force: true })
  const token = generateSetupToken()
  await withServer(async (base) => {
    const [a, b] = await Promise.all([setup(base, token, 'first'), setup(base, token, 'second')])
    const statuses = [a.status, b.status].sort()
    assert.equal(statuses[0], 200)
    assert.notEqual(statuses[1], 200)
  })
})
