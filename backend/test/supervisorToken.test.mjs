import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const seen = []
const supervisor = http.createServer((req, res) => {
  seen.push({ url: req.url, token: req.headers['x-supervisor-token'] || null })
  if (req.headers['x-supervisor-token'] !== 'tok-123') {
    res.writeHead(401)
    return res.end('missing or invalid supervisor token')
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, mode: 'normal', running: true }))
})
await new Promise((r) => supervisor.listen(0, '127.0.0.1', r))

const secretDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-sup-token-'))
const tokenFile = path.join(secretDir, 'token')
process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-sup-cfg-'))
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_SUPERVISOR_PORT = String(supervisor.address().port)
process.env.AMDL_SUPERVISOR_TOKEN_FILE = tokenFile

const { wakeWrapper } = await import('../lib/wrapperLogin.mjs')

test.after(() => supervisor.close())

test('control calls send the supervisor token from the shared file', async () => {
  await fsp.writeFile(tokenFile, 'tok-123\n')
  const r = await wakeWrapper()
  assert.equal(r?.ok, true)
  assert.deepEqual(seen.at(-1), { url: '/wake', token: 'tok-123' })
})

test('a token recreated by the supervisor is picked up without a restart', async () => {
  await fsp.writeFile(tokenFile, 'old-token\n')
  assert.equal(await wakeWrapper(), null)
  await fsp.writeFile(tokenFile, 'tok-123\n')
  assert.equal((await wakeWrapper())?.ok, true)
})

test('without the token file the call is rejected, not crashed', async () => {
  await fsp.rm(tokenFile, { force: true })
  const errors = []
  const orig = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    assert.equal(await wakeWrapper(), null)
  } finally {
    console.error = orig
  }
  assert.equal(seen.at(-1).token, null)
  assert.ok(errors.some((e) => e.includes('supervisor token')))
})
