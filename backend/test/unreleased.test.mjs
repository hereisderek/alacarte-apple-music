import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-unreleased-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-unreleased-music-'))

const { isReleasedTrack, formatReleaseDate, normalizeAlbum } = await import('../lib/appleApi.mjs')
const { notReleasedError } = await import('../lib/queue.mjs')

const track = (id, released) => ({
  id,
  type: 'songs',
  attributes: { name: `Track ${id}`, trackNumber: Number(id), ...(released ? { playParams: { id, kind: 'song' } } : {}) },
})

test('a track without playParams is not released yet', () => {
  assert.equal(isReleasedTrack(track('1', true)), true)
  assert.equal(isReleasedTrack(track('2', false)), false)
  assert.equal(isReleasedTrack(null), false)
})

test('pre-release albums keep every track but mark which are out', () => {
  const album = normalizeAlbum({
    id: '9',
    attributes: { name: 'Infinite Now', artistName: 'Two Shell', releaseDate: '2026-10-16', isPrerelease: true },
    relationships: { tracks: { data: [track('1', false), track('5', true)] } },
  })
  assert.equal(album.isPrerelease, true)
  assert.deepEqual(album.tracks.map((t) => [t.id, t.released]), [['1', false], ['5', true]])
})

test('the not-released error says when the album comes out', () => {
  assert.equal(formatReleaseDate('2026-10-16'), '16 October 2026')
  assert.equal(formatReleaseDate(null), null)
  const err = notReleasedError('2026-10-16')
  assert.equal(err.message, 'Not released yet (out 16 October 2026)')
  assert.equal(err.code, 'NOT_RELEASED')
  assert.equal(err.statusCode, 409)
  assert.equal(notReleasedError(null).message, 'Not released yet')
})
