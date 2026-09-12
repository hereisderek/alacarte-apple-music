import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyVariantSuffix,
  groupOf,
  parseVariantSuffix,
} from '../lib/qualityGroups.mjs'

const ts = () => Date.now() + Math.floor(Math.random() * 1e6)

test('groupOf maps qualities into version groups', () => {
  assert.equal(groupOf('flac'), 'lossless')
  assert.equal(groupOf('alac'), 'lossless')
  assert.equal(groupOf('atmos'), 'atmos')
  assert.equal(groupOf('aac'), 'aac')
  assert.equal(groupOf('bogus'), 'lossless')
})

test('applyVariantSuffix labels lossless variants by requested codec', () => {
  assert.equal(applyVariantSuffix('/music/A/N', 'atmos', 'atmos'), '/music/A/N (Atmos)')
  assert.equal(applyVariantSuffix('/music/A/N', 'aac', 'aac'), '/music/A/N (AAC)')
  assert.equal(applyVariantSuffix('/music/A/N', 'lossless', 'flac'), '/music/A/N (FLAC)')
  assert.equal(applyVariantSuffix('/music/A/N', 'lossless', 'alac'), '/music/A/N (ALAC)')
})

test('parseVariantSuffix round-trips folder suffixes back to groups', () => {
  assert.equal(parseVariantSuffix('Negro Swan (Atmos)'), 'atmos')
  assert.equal(parseVariantSuffix('Negro Swan (AAC)'), 'aac')
  assert.equal(parseVariantSuffix('Negro Swan (FLAC)'), 'lossless')
  assert.equal(parseVariantSuffix('Negro Swan (ALAC)'), 'lossless')
  assert.equal(parseVariantSuffix('Negro Swan'), null)
  assert.equal(parseVariantSuffix('Album (2019)'), null)
})

test('scanLibrary maps variant album folders onto the base album key', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-variants-'))
  const prevRoot = process.env.AMDL_MUSIC_PATH
  process.env.AMDL_MUSIC_PATH = dir
  try {
    const losslessDir = path.join(dir, 'Blood Orange', 'Negro Swan')
    const atmosDir = path.join(dir, 'Blood Orange', 'Negro Swan (Atmos)')
    await fsp.mkdir(losslessDir, { recursive: true })
    await fsp.mkdir(atmosDir, { recursive: true })
    await fsp.writeFile(path.join(losslessDir, '01. Orlando.flac'), 'x')
    await fsp.writeFile(path.join(atmosDir, '01. Orlando.m4a'), 'x')

    const mod = await import(`../lib/libraryIndex.mjs?ts=${ts()}`)
    mod.invalidateLibraryCache()
    const index = await mod.scanLibrary()

    const baseKey = mod.makeAlbumKey('Blood Orange', 'Negro Swan')
    const variants = index.albumVersionGroups.get(baseKey)
    assert.ok(variants, 'base album key has version entry')
    assert.ok(variants.has('atmos'))
    assert.ok(variants.has('lossless'))
    assert.ok(index.albumKeys.has(mod.makeAlbumKey('Blood Orange', 'Negro Swan (Atmos)')))

    const groups = await mod.getAlbumVersionGroups('Blood Orange', 'Negro Swan')
    assert.deepEqual(Array.from(groups).sort(), ['atmos', 'lossless'])
  } finally {
    process.env.AMDL_MUSIC_PATH = prevRoot
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('scanLibrary reads .alacarte-version markers over suffix inference', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-marker-'))
  const prevRoot = process.env.AMDL_MUSIC_PATH
  process.env.AMDL_MUSIC_PATH = dir
  try {
    const albumDir = path.join(dir, 'Blood Orange', 'Negro Swan')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(path.join(albumDir, '01. Orlando.m4a'), 'x')
    await fsp.writeFile(path.join(albumDir, '.alacarte-version'), 'atmos')

    const mod = await import(`../lib/libraryIndex.mjs?ts=${ts()}`)
    mod.invalidateLibraryCache()
    const index = await mod.scanLibrary()
    const groups = index.albumVersionGroups.get(mod.makeAlbumKey('Blood Orange', 'Negro Swan'))
    assert.ok(groups.has('atmos'))
    assert.ok(!groups.has('lossless'))
  } finally {
    process.env.AMDL_MUSIC_PATH = prevRoot
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('getAlbumVersionGroups reports lossless for primary folders and upc hits', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-variants-'))
  const prevRoot = process.env.AMDL_MUSIC_PATH
  process.env.AMDL_MUSIC_PATH = dir
  try {
    const albumDir = path.join(dir, 'Blood Orange', 'Negro Swan')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(path.join(albumDir, '01. Orlando.flac'), 'x')

    const mod = await import(`../lib/libraryIndex.mjs?ts=${ts()}`)
    mod.invalidateLibraryCache()
    const groups = await mod.getAlbumVersionGroups('Blood Orange', 'Negro Swan')
    assert.ok(groups.has('lossless'))
  } finally {
    process.env.AMDL_MUSIC_PATH = prevRoot
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
