import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import express from 'express'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-int-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-music-'))
const TOKEN = 'test-token-0123456789abcdefghij'

await fsp.writeFile(path.join(tmpConfig, '.secret'), crypto.randomBytes(32).toString('hex'))
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
loadSecretsAtBoot(tmpConfig)
const { encryptSecret, writeSettings } = await import('../lib/settingsStore.mjs')
const { hasValidApiToken } = await import('../lib/apiToken.mjs')
const { originGuard } = await import('../lib/originGuard.mjs')
const { integrationRouter } = await import('../routes/integration.mjs')
const { mapAlbum, mapSong } = await import('../lib/integrationCatalog.mjs')

function req(p, { auth, method = 'GET' } = {}) {
  return { path: p, baseUrl: '', method, headers: { host: 'server:7373', ...(auth ? { authorization: auth } : {}) } }
}

async function integration(enabled, token = TOKEN) {
  await writeSettings({ octoIntegrationEnabled: enabled, octoIntegrationToken: token ? encryptSecret(token) : null })
}

// A bare app with only the integration router, i.e. what AUTH_DISABLED leaves in front of it.
async function status(auth) {
  const app = express().use('/api/integration/v1', integrationRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/integration/v1/nothing-here`, {
      headers: auth ? { authorization: auth } : {},
    })
    return res.status
  } finally {
    server.close()
  }
}

test('the integration token comes from Settings and only opens the integration api', async () => {
  const good = req('/api/integration/v1/search', { auth: `Bearer ${TOKEN}` })
  await integration(false)
  assert.equal(await hasValidApiToken(good), false)
  await integration(true)
  assert.equal(await hasValidApiToken(good), true)
  assert.equal(await hasValidApiToken(req('/api/integration/v1/search', { auth: `Bearer ${TOKEN}x` })), false)
  assert.equal(await hasValidApiToken(req('/api/integration/v1/search')), false)
  assert.equal(await hasValidApiToken(req('/api/settings', { auth: `Bearer ${TOKEN}` })), false)
  await integration(true, 'regenerated-0123456789abcdefghij')
  assert.equal(await hasValidApiToken(good), false)
})

test('the integration api is closed when off or without the token, even with auth disabled', async () => {
  await integration(false)
  assert.equal(await status(`Bearer ${TOKEN}`), 404)
  await integration(true)
  assert.equal(await status(), 401)
  assert.equal(await status('Bearer wrong'), 401)
  assert.equal(await status(`Bearer ${TOKEN}`), 404) // passes the gate; the route just does not exist
})

test('the origin guard lets token-authenticated integration posts through', async () => {
  await integration(true)
  const guard = originGuard()
  const run = async (r) => {
    let result = null
    await guard(r, { status: (s) => ({ json: () => (result = s) }) }, () => (result = 'next'))
    return result
  }
  assert.equal(await run(req('/api/integration/v1/songs/1/ensure', { method: 'POST', auth: `Bearer ${TOKEN}` })), 'next')
  assert.equal(await run(req('/api/integration/v1/songs/1/ensure', { method: 'POST' })), 403)
  assert.equal(await run(req('/api/download', { method: 'POST', auth: `Bearer ${TOKEN}` })), 403)
})

test('catalog songs map to flat provider records with ready artwork urls', () => {
  const song = mapSong({
    id: 697401647,
    attributes: {
      name: 'One More Time (Radio Edit)',
      artistName: 'Daft Punk',
      albumName: 'One More Time - Single',
      url: 'https://music.apple.com/pl/album/one-more-time-single/697401639?i=697401647',
      trackNumber: 2,
      discNumber: 1,
      durationInMillis: 321000,
      isrc: 'GBDUW0000050',
      releaseDate: '2000-11-13',
      genreNames: ['Dance', 'Music'],
      contentRating: 'explicit',
      artwork: { url: 'https://is1.mzstatic.com/x/{w}x{h}bb.{f}' },
    },
  })
  assert.equal(song.id, '697401647')
  assert.equal(song.albumId, '697401639')
  assert.equal(song.year, 2000)
  assert.equal(song.genre, 'Dance')
  assert.equal(song.explicit, true)
  assert.equal(song.artworkUrl, 'https://is1.mzstatic.com/x/600x600bb.jpg')
  assert.equal(song.artworkUrlLarge, 'https://is1.mzstatic.com/x/1400x1400bb.jpg')

  const album = mapAlbum({ id: '1', attributes: { name: 'A', artistName: 'B', isSingle: true, trackCount: 3 } })
  const track = mapSong({ id: '2', attributes: { name: 'T' } }, album)
  assert.equal(album.releaseType, 'single')
  assert.equal(track.album, 'A')
  assert.equal(track.albumId, '1')
  assert.equal(track.albumArtist, 'B')
})
