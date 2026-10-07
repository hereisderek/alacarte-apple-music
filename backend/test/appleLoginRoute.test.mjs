import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const logins = []
const supervisor = http.createServer((req, res) => {
  if (req.url === '/login') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      logins.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('[.] account info cached successfully\n')
    })
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, mode: 'normal', running: true }))
})
await new Promise((r) => supervisor.listen(0, '127.0.0.1', r))

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-apple-login-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_SUPERVISOR_PORT = String(supervisor.address().port)

const { ensureConfigDir, writeSettings, encryptSecret } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)
const { settingsRouter } = await import('../routes/settings.mjs')

test.after(() => supervisor.close())

async function postLogin() {
  const app = express()
  app.use(express.json())
  app.use('/api/settings', settingsRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/settings/apple-credentials/login`, {
      method: 'POST',
    })
    return { status: res.status, body: await res.json() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('signing in again without stored credentials is refused', async () => {
  const r = await postLogin()
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'no credentials stored')
})

test('signing in again uses the stored apple id', async () => {
  await writeSettings({ appleEmail: encryptSecret('me@example.com'), applePassword: encryptSecret('pw:with:colons') })
  const r = await postLogin()
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, loginStarted: true })
  const deadline = Date.now() + 3000
  while (logins.length === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20))
  assert.deepEqual(logins.at(-1), { email: 'me@example.com', password: 'pw:with:colons' })
})
