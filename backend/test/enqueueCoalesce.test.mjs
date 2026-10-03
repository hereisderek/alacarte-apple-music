import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-enqueue-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-enqueue-music-'))
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

// Slow fake Apple: every lookup takes a while, like the real catalog API.
const realFetch = globalThis.fetch
let catalogCalls = 0
globalThis.fetch = async (url) => {
  await new Promise((r) => setTimeout(r, 30))
  const u = String(url)
  if (u === 'https://music.apple.com') {
    return new Response('<script src="/assets/index~abc.js"></script>')
  }
  if (u.includes('/assets/index~')) return new Response('x="eyJa.eyJb.sig"')
  catalogCalls++
  const id = u.match(/\/(albums|songs|playlists)\/([^/?]+)/)?.[2]
  return Response.json({
    data: [
      {
        id,
        type: 'albums',
        attributes: { name: `Item ${id}`, artistName: 'Someone', trackCount: 1, url: '' },
        relationships: { tracks: { data: [] }, albums: { data: [{ id: '77' }] } },
      },
    ],
  })
}

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpConfig)
loadSecretsAtBoot(tmpConfig)
const { enqueueAlbum, enqueueSong, enqueuePlaylist, setQueuePaused, __test__ } =
  await import('../lib/queue.mjs')
const { state } = __test__

setQueuePaused(true)
test.after(() => {
  globalThis.fetch = realFetch
})

const queuedFor = (pred) => [...state.jobs.values()].filter((j) => j.status === 'queued' && pred(j))

test('requests for the same album arriving together make one job', async () => {
  const jobs = await Promise.all([
    enqueueAlbum({ albumId: '100' }),
    enqueueAlbum({ albumId: '100', quality: 'flac' }),
    enqueueAlbum({ albumId: '100', quality: 'alac' }),
  ])
  assert.equal(new Set(jobs.map((j) => j.id)).size, 1)
  assert.equal(queuedFor((j) => j.albumId === '100').length, 1)
})

test('a different quality group is still its own job', async () => {
  const [a, b] = await Promise.all([
    enqueueAlbum({ albumId: '200', quality: 'flac' }),
    enqueueAlbum({ albumId: '200', quality: 'atmos' }),
  ])
  assert.notEqual(a.id, b.id)
})

test('songs and playlists are not queued twice either', async () => {
  const songs = await Promise.all([enqueueSong({ songId: '300' }), enqueueSong({ songId: '300' })])
  assert.equal(songs[0].id, songs[1].id)
  assert.equal(queuedFor((j) => j.songId === '300').length, 1)

  const lists = await Promise.all([
    enqueuePlaylist({ playlistId: 'pl.1' }),
    enqueuePlaylist({ playlistId: 'pl.1' }),
  ])
  assert.equal(lists[0].id, lists[1].id)
  assert.equal(queuedFor((j) => j.playlistId === 'pl.1').length, 1)
})

test('a later request after the first finished still reuses the queued job', async () => {
  const first = await enqueueAlbum({ albumId: '400' })
  const second = await enqueueAlbum({ albumId: '400' })
  assert.equal(first.id, second.id)
})
