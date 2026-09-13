import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-veropt-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
await ensureConfigDir(tmpDir)

const { settingsRouter, WRITABLE_KEYS } = await import('../routes/settings.mjs')

test('WRITABLE_KEYS includes version options keys', () => {
  assert.ok(WRITABLE_KEYS.has('versionOptionsEnabled'))
  assert.ok(WRITABLE_KEYS.has('versionOptions'))
})

async function withSettingsServer(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api/settings', settingsRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function jsonRequest(base, method, body) {
  const res = await fetch(`${base}/api/settings`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

test('version options default to disabled with all groups', async () => {
  await withSettingsServer(async (base) => {
    const s = await jsonRequest(base, 'GET')
    assert.equal(s.versionOptionsEnabled, false)
    assert.deepEqual([...s.versionOptions].sort(), ['aac', 'atmos', 'lossless'])
  })
})

test('PUT persists enabled state and filters invalid groups', async () => {
  await withSettingsServer(async (base) => {
    const s = await jsonRequest(base, 'PUT', {
      versionOptionsEnabled: true,
      versionOptions: ['atmos', 'aac', 'bogus'],
    })
    assert.equal(s.versionOptionsEnabled, true)
    assert.deepEqual([...s.versionOptions].sort(), ['aac', 'atmos'])
  })
})

test('PUT rejects non-boolean enable and non-array formats, leaving state untouched', async () => {
  await withSettingsServer(async (base) => {
    // prior tests persisted enabled=true with ["aac","atmos"]; the rejected
    // patch must leave that state exactly as-is
    const s = await jsonRequest(base, 'PUT', {
      versionOptionsEnabled: 'yes',
      versionOptions: 'atmos',
    })
    assert.equal(s.versionOptionsEnabled, true)
    assert.deepEqual([...s.versionOptions].sort(), ['aac', 'atmos'])
  })
})
