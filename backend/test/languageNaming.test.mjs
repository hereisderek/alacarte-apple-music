import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-lang-naming-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { __test__ } = await import('../lib/queue.mjs')
const { resolveAlbumNaming, renameTrackFilesForLanguage } = __test__

test('resolveAlbumNaming: display mode is a pure no-op fast path (no Apple API call, no storefront needed)', async () => {
  const meta = {
    name: 'Bubbles (2024)',
    artistName: 'Some Artist',
    tracks: [{ id: '1', name: 'Track One', trackNumber: 1, isrc: 'AAA' }],
  }
  const result = await resolveAlbumNaming({
    settings: { namingLanguageMode: 'display', acceptedLanguages: [] },
    storefront: 'not-a-real-storefront', // would throw if this path tried a real fetch
    albumId: 'irrelevant',
    meta,
  })
  assert.equal(result.albumTitle, 'Bubbles')
  assert.equal(result.artist, 'Some Artist')
  assert.equal(result.originalAlbumTitle, null)
  assert.equal(result.originalArtist, null)
  assert.deepEqual(result.trackNameOverrides, [])
})

test('resolveAlbumNaming: unmapped storefront falls back to display-only naming', async () => {
  const meta = { name: 'Something', artistName: 'Artist', tracks: [] }
  const result = await resolveAlbumNaming({
    settings: { namingLanguageMode: 'dual', acceptedLanguages: [] },
    storefront: 'zz', // not in STOREFRONT_HOME_LANGUAGE
    albumId: '123',
    meta,
  })
  assert.equal(result.albumTitle, 'Something')
  assert.equal(result.originalAlbumTitle, null)
})

test('renameTrackFilesForLanguage renames matching audio + lrc sidecars, fail-soft otherwise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alacarte-lang-rename-'))
  fs.writeFileSync(path.join(dir, '01. Bubbles.flac'), 'x')
  fs.writeFileSync(path.join(dir, '01. Bubbles.lrc'), 'x')
  fs.writeFileSync(path.join(dir, '02. Untouched.flac'), 'x')

  const overrides = [
    { id: 't1', name: 'Bubbles', trackNumber: 1, resolvedName: '泡沫' },
    { id: 't2', name: 'Untouched', trackNumber: 2, resolvedName: 'Untouched' }, // unchanged
  ]

  await renameTrackFilesForLanguage(dir, overrides)

  const entries = fs.readdirSync(dir).sort()
  assert.deepEqual(entries, ['01. 泡沫.flac', '01. 泡沫.lrc', '02. Untouched.flac'])
})

test('renameTrackFilesForLanguage is a no-op with no overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alacarte-lang-rename-empty-'))
  fs.writeFileSync(path.join(dir, '01. Song.flac'), 'x')
  await renameTrackFilesForLanguage(dir, [])
  await renameTrackFilesForLanguage(dir, null)
  assert.deepEqual(fs.readdirSync(dir), ['01. Song.flac'])
})
