import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

// Fake amdp goes quiet past the (lowered) stall warning threshold, then
// carries on and finishes; MP4Box and ffmpeg are faked.
const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-stallwd-bin-'))
const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
script('MP4Box', 'echo "MP4Box - GPAC version 2.2"')
script('ffmpeg', 'for last; do :; done\nprintf flac > "$last"')
script(
  'apple-music-dl',
  'echo "Track 1 of 1: Song"\nsleep 11\nmkdir -p "Artist/Album" && printf x > "Artist/Album/01. Song.m4a"\necho "done"\nsleep 6\necho "finished"',
)
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.AMDL_STALL_WARN_MS = '5000'

const servers = []
const ports = []
for (let i = 0; i < 3; i++) {
  const s = net.createServer((c) => c.destroy())
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  servers.push(s)
  ports.push(s.address().port)
}
const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-stallwd-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-stallwd-music-'))
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_DECRYPT_PORT = String(ports[0])
process.env.AMDL_WRAPPER_M3U8_PORT = String(ports[1])
process.env.AMDL_WRAPPER_ACCOUNT_PORT = String(ports[2])
process.env.AMDL_WRAPPER_SUPERVISOR_PORT = '1'

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpConfig)
loadSecretsAtBoot(tmpConfig)
const { onEvent } = await import('../lib/eventBus.mjs')
const { getWrapperEventState } = await import('../lib/wrapperHealth.mjs')
const { __test__ } = await import('../lib/queue.mjs')
const { state, tickQueue } = __test__

test.after(() => {
  for (const s of servers) s.close()
})

test('a quiet patch during a download is flagged and then cleared once output resumes', async () => {
  const seen = []
  const activeDuring = []
  const off = onEvent((ev) => {
    if (ev.type.startsWith('wrapper.stall')) {
      seen.push(`${ev.type}:${ev.data.phase || ''}`)
      activeDuring.push(getWrapperEventState().stallActive)
    }
  })
  const job = {
    id: crypto.randomUUID(),
    kind: 'album',
    status: 'queued',
    albumId: '1',
    albumTitle: 'Album',
    artist: 'Artist',
    storefront: 'us',
    quality: 'alac',
    createdAt: Date.now(),
    stats: { total: 1, done: 0, failed: 0 },
  }
  state.jobs.set(job.id, job)
  state.queue.push(job.id)
  await tickQueue()
  const deadline = Date.now() + 40_000
  while (state.active.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  off()
  assert.equal(job.status, 'done', job.error)
  assert.deepEqual(seen, ['wrapper.stall.suspected:warning', 'wrapper.stall.cleared:'])
  assert.deepEqual(activeDuring, [true, false])
  const s = getWrapperEventState()
  assert.equal(s.stallActive, false)
  assert.ok(s.stallEndedAt > 0)
})
