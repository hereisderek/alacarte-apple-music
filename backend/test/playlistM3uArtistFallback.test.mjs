import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { invalidateLibraryCache } from '../lib/libraryIndex.mjs'
import * as store from '../lib/followedPlaylistsStore.mjs'

async function withMusicRoot(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-m3u-'))
    const prevRoot = process.env.AMDL_MUSIC_PATH
    process.env.AMDL_MUSIC_PATH = dir
    invalidateLibraryCache()
    try {
        await fn(dir)
    } finally {
        invalidateLibraryCache()
        process.env.AMDL_MUSIC_PATH = prevRoot
        await fsp.rm(dir, { recursive: true, force: true })
    }
}

function record(overrides = {}) {
    return {
        name: 'Picks',
        catalogId: null,
        libraryId: 'lib-1',
        artworkTemplate: null,
        trackIndex: [{ id: '1', name: 'Orlando', artistName: 'Blood Orange' }],
        ...overrides,
    }
}

test('rebuildFollowedPlaylistM3u includes tracks stored under a different artist folder', async () => {
    await withMusicRoot(async (dir) => {
        const trackDir = path.join(dir, 'Various Artists', 'Negro Swan')
        await fsp.mkdir(trackDir, { recursive: true })
        await fsp.writeFile(path.join(trackDir, '01. Orlando.flac'), 'x')

        const m3uPath = await store.rebuildFollowedPlaylistM3u(record())
        assert.ok(m3uPath, 'm3u was written')

        const text = await fsp.readFile(m3uPath, 'utf8')
        assert.ok(text.includes('../Various Artists/Negro Swan/01. Orlando.flac'))
    })
})

test('rebuildFollowedPlaylistM3u keeps artist-qualified matches first', async () => {
    await withMusicRoot(async (dir) => {
        const ownDir = path.join(dir, 'Blood Orange', 'Negro Swan')
        const vaDir = path.join(dir, 'Various Artists', 'Negro Swan')
        await fsp.mkdir(ownDir, { recursive: true })
        await fsp.mkdir(vaDir, { recursive: true })
        await fsp.writeFile(path.join(ownDir, '01. Orlando.flac'), 'x')
        await fsp.writeFile(path.join(vaDir, '01. Orlando.flac'), 'x')

        const m3uPath = await store.rebuildFollowedPlaylistM3u(record())
        const text = await fsp.readFile(m3uPath, 'utf8')
        assert.ok(text.includes('../Blood Orange/Negro Swan/01. Orlando.flac'))
        assert.ok(!text.includes('Various Artists'))
    })
})

test('rebuildFollowedPlaylistM3u omits tracks when no matching file exists', async () => {
    await withMusicRoot(async (dir) => {
        const m3uPath = await store.rebuildFollowedPlaylistM3u(record())
        assert.equal(m3uPath, null)
    })
})


test('rebuildFollowedPlaylistM3u resolves the recorded atmos version', async () => {
    await withMusicRoot(async (dir) => {
        const ownDir = path.join(dir, 'Blood Orange', 'Negro Swan')
        const atmosDir = path.join(dir, 'Blood Orange', 'Negro Swan (Atmos)')
        await fsp.mkdir(ownDir, { recursive: true })
        await fsp.mkdir(atmosDir, { recursive: true })
        await fsp.writeFile(path.join(ownDir, '01. Orlando.flac'), 'x')
        await fsp.writeFile(path.join(atmosDir, '01. Orlando.m4a'), 'x')

        const m3uPath = await store.rebuildFollowedPlaylistM3u(
            record({
                trackIndex: [
                    {
                        id: '1',
                        name: 'Orlando',
                        artistName: 'Blood Orange',
                        version: 'atmos',
                    },
                ],
            }),
        )
        const text = await fsp.readFile(m3uPath, 'utf8')
        assert.ok(
            text.includes('../Blood Orange/Negro Swan (Atmos)/01. Orlando.m4a'),
        )
        assert.ok(!text.includes('../Blood Orange/Negro Swan/01.'))
    })
})

test('rebuildFollowedPlaylistM3u falls back to lossless when the recorded version folder is gone', async () => {
    await withMusicRoot(async (dir) => {
        const ownDir = path.join(dir, 'Blood Orange', 'Negro Swan')
        await fsp.mkdir(ownDir, { recursive: true })
        await fsp.writeFile(path.join(ownDir, '01. Orlando.flac'), 'x')

        const m3uPath = await store.rebuildFollowedPlaylistM3u(
            record({
                trackIndex: [
                    {
                        id: '1',
                        name: 'Orlando',
                        artistName: 'Blood Orange',
                        version: 'atmos',
                    },
                ],
            }),
        )
        const text = await fsp.readFile(m3uPath, 'utf8')
        assert.ok(text.includes('../Blood Orange/Negro Swan/01. Orlando.flac'))
    })
})

test('rebuildFollowedPlaylistM3u prefers lossless when no version was recorded', async () => {
    await withMusicRoot(async (dir) => {
        const ownDir = path.join(dir, 'Blood Orange', 'Negro Swan')
        const aacDir = path.join(dir, 'Blood Orange', 'Negro Swan (AAC)')
        await fsp.mkdir(ownDir, { recursive: true })
        await fsp.mkdir(aacDir, { recursive: true })
        await fsp.writeFile(path.join(ownDir, '01. Orlando.flac'), 'x')
        await fsp.writeFile(path.join(aacDir, '01. Orlando.m4a'), 'x')

        const m3uPath = await store.rebuildFollowedPlaylistM3u(record())
        const text = await fsp.readFile(m3uPath, 'utf8')
        assert.ok(text.includes('../Blood Orange/Negro Swan/01. Orlando.flac'))
        assert.ok(!text.includes('.m4a'))
    })
})

test('rebuildFollowedPlaylistM3u resolves the recorded aac version', async () => {
    await withMusicRoot(async (dir) => {
        const ownDir = path.join(dir, 'Blood Orange', 'Negro Swan')
        const aacDir = path.join(dir, 'Blood Orange', 'Negro Swan (AAC)')
        await fsp.mkdir(ownDir, { recursive: true })
        await fsp.mkdir(aacDir, { recursive: true })
        await fsp.writeFile(path.join(ownDir, '01. Orlando.flac'), 'x')
        await fsp.writeFile(path.join(aacDir, '01. Orlando.m4a'), 'x')

        const m3uPath = await store.rebuildFollowedPlaylistM3u(
            record({
                trackIndex: [
                    {
                        id: '1',
                        name: 'Orlando',
                        artistName: 'Blood Orange',
                        version: 'aac',
                    },
                ],
            }),
        )
        const text = await fsp.readFile(m3uPath, 'utf8')
        assert.ok(text.includes('../Blood Orange/Negro Swan (AAC)/01. Orlando.m4a'))
    })
})
