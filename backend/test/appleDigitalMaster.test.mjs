import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeAlbum, normalizePlaylist } from '../lib/appleApi.mjs'

const track = (id, isAppleDigitalMaster) => ({ id, type: 'songs', attributes: { name: id, isAppleDigitalMaster } })

test('albums carry the Apple Digital Master flag from isMasteredForItunes', () => {
  const adm = normalizeAlbum({
    id: '1',
    attributes: { name: 'A', isMasteredForItunes: true },
    relationships: { tracks: { data: [track('t1', true), track('t2', true)] } },
  })
  assert.equal(adm.isAppleDigitalMaster, true)
  assert.deepEqual(adm.tracks.map((t) => t.isAppleDigitalMaster), [true, true])

  // a mixed album: the album is not flagged, one bonus track is
  const mixed = normalizeAlbum({
    id: '2',
    attributes: { name: 'B' },
    relationships: { tracks: { data: [track('t1', false), track('t2', true)] } },
  })
  assert.equal(mixed.isAppleDigitalMaster, false)
  assert.deepEqual(mixed.tracks.map((t) => t.isAppleDigitalMaster), [false, true])
})

test('playlist tracks carry their own Apple Digital Master flag', () => {
  const playlist = normalizePlaylist({
    id: 'pl.1',
    attributes: { name: 'Mix' },
    relationships: { tracks: { data: [track('t1', true), track('t2', undefined)] } },
  })
  assert.deepEqual(playlist.tracks.map((t) => t.isAppleDigitalMaster), [true, false])
})
