import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

// Fake amdp, MP4Box and ffmpeg on PATH: amdp drops one m4a into staging and
// ffmpeg hangs, so the job sits in FLAC conversion until it is cancelled.
const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-fakebin-'))
const script = (name, body) => {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}
script('MP4Box', 'echo "MP4Box - GPAC version 2.2"')
script('apple-music-dl', 'mkdir -p "Artist/Album" && printf x > "Artist/Album/01. Song.m4a" && echo "Track 1 of 1: Song"')
script('ffmpeg', 'exec sleep 5')
process.env.PATH = `${bin}:${process.env.PATH}`

const wrapperServers = []
const ports = []
for (let i = 0; i < 3; i++) {
  const s = net.createServer((c) => c.destroy())
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  wrapperServers.push(s)
  ports.push(s.address().port)
}

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-cancel-'))
const tmpMusic = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-cancel-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_DECRYPT_PORT = String(ports[0])
process.env.AMDL_WRAPPER_M3U8_PORT = String(ports[1])
process.env.AMDL_WRAPPER_ACCOUNT_PORT = String(ports[2])

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpConfig)
loadSecretsAtBoot(tmpConfig)
const { cancelJob, __test__ } = await import('../lib/queue.mjs')
const { state, tickQueue, importingJobs } = __test__

test.after(() => {
  for (const s of wrapperServers) s.close()
})

function addAlbumJob() {
  const job = {
    id: crypto.randomUUID(),
    kind: 'album',
    status: 'queued',
    progress: 0,
    albumId: '1',
    albumTitle: 'Album',
    artist: 'Artist',
    storefront: 'us',
    quality: 'flac',
    createdAt: Date.now(),
    stats: { total: 1, done: 0, failed: 0 },
  }
  state.jobs.set(job.id, job)
  state.queue.push(job.id)
  return job
}

async function waitFor(cond, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('cancelling during FLAC conversion stops the job before it imports', async () => {
  const job = addAlbumJob()
  await tickQueue()
  await waitFor(() => /Converting to FLAC/.test(job.message || ''))
  const startedAt = Date.now()
  const r = await cancelJob(job.id)
  assert.equal(r.ok, true)
  await waitFor(() => state.active.size === 0)
  assert.ok(Date.now() - startedAt < 3000, 'ffmpeg is killed instead of waited out')
  assert.equal(job.status, 'failed')
  assert.equal(job.cancelled, true)
  assert.deepEqual(await fsp.readdir(tmpMusic), [], 'nothing is moved into the library')
})

test('cancelling is refused while a job moves files into the library', async () => {
  const job = addAlbumJob()
  state.queue = state.queue.filter((id) => id !== job.id)
  job.status = 'running'
  state.active.add(job.id)
  importingJobs.add(job.id)
  try {
    const r = await cancelJob(job.id)
    assert.equal(r.ok, false)
    assert.equal(job.status, 'running')
    assert.notEqual(job.cancelled, true)
  } finally {
    importingJobs.delete(job.id)
    state.active.delete(job.id)
  }
})
