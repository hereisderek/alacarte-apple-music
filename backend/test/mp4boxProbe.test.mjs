import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-fake-mp4box-'))
const fakeMp4Box = (body) =>
  fs.writeFileSync(path.join(bin, 'MP4Box'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-mp4box-cfg-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-mp4box-music-'))
// Nothing listens here, so the wrapper and supervisor probes fail fast.
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_SUPERVISOR_PORT = '1'
process.env.AMDL_WRAPPER_DECRYPT_PORT = '1'
process.env.AMDL_WRAPPER_M3U8_PORT = '1'
process.env.AMDL_WRAPPER_ACCOUNT_PORT = '1'

const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, opts) : new Response('', { status: 503 })

const { probeMp4Box } = await import('../lib/amdpRunner.mjs')
const { healthRouter } = await import('../routes/health.mjs')

test.after(() => {
  globalThis.fetch = realFetch
})

async function healthMp4Box() {
  const app = express()
  app.use('/api/health', healthRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/health`)
    return (await res.json()).tools.mp4box
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('an MP4Box that prints its version but exits non-zero counts as working everywhere', async () => {
  fakeMp4Box('echo "MP4Box - GPAC version 2.4"; exit 1')
  assert.equal((await probeMp4Box()).ok, true)
  assert.equal((await healthMp4Box()).ok, true)
})

test('a broken MP4Box is reported the same way by downloads and the health page', async () => {
  fakeMp4Box('echo "segfault" >&2; exit 139')
  const probe = await probeMp4Box()
  assert.equal(probe.ok, false)
  assert.deepEqual(await healthMp4Box(), probe)
})
