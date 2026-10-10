import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'
import {
    readAudioIdentityTags,
    readAudioMetaTags,
    writeAudioIdentityTags,
} from './audioTags.mjs'
import { readSettings } from './settingsStore.mjs'
import { getAlbum, searchCatalog } from './appleApi.mjs'
import { runInLane } from './appleGateway.mjs'
import { isAppleRateLimited, withAppleRetry } from './appleWait.mjs'
import { invalidateLibraryCache } from './libraryIndex.mjs'
import { normalizeForMatchKey } from './libraryMatchKey.mjs'

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const PROGRESS_MIN_INTERVAL_MS = 400

// One shared background run: resolves untagged FLACs against the Apple
// catalog and stamps ISRC/BARCODE so presence matching works regardless of
// folder naming. Long-running by nature, hence the start/status/stop shape
// instead of a request/response endpoint.
//
// Apple is asked per album folder (one search plus one album fetch carry the ISRC
// of every track and the album's UPC); a per-file song search is only the fallback
// for files the album did not explain. All calls go through the Apple gateway in
// the background lane, and a rate limit pauses the run instead of failing files.
const state = {
    running: false,
    phase: 'idle', // idle | scanning | matching | waiting | done
    dryRun: false,
    scanned: 0,
    total: 0,
    albumsDone: 0,
    albumsTotal: 0,
    appleCalls: 0,
    waitingUntil: null,
    stamped: 0,
    skipped: 0,
    noMatch: 0,
    failed: 0,
    current: null,
    startedAt: null,
    finishedAt: null,
    stopRequested: false,
    error: null,
}

const defaultDeps = {
    searchCatalog,
    getAlbum,
    readSettings,
    now: () => Date.now(),
}

let lastEmitAt = 0

function status() {
    return {
        running: state.running,
        phase: state.phase,
        dryRun: state.dryRun,
        scanned: state.scanned,
        total: state.total,
        albumsDone: state.albumsDone,
        albumsTotal: state.albumsTotal,
        appleCalls: state.appleCalls,
        waitingUntil: state.waitingUntil,
        stamped: state.stamped,
        skipped: state.skipped,
        noMatch: state.noMatch,
        failed: state.failed,
        current: state.current,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        stopRequested: state.stopRequested,
        error: state.error,
    }
}

export function getTagBackfillStatus() {
    return status()
}

export function stopTagBackfill() {
    if (!state.running) return { ok: false, running: false }
    state.stopRequested = true
    emit(true)
    return { ok: true, running: true }
}

function emit(force = false) {
    const now = Date.now()
    if (!force && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) return
    lastEmitAt = now
    emitEvent('tags.backfill.progress', {
        ...status(),
        done: !state.running,
    })
}

function nameMatchesLoose(a, b) {
    const x = normalizeForMatchKey(a).toLowerCase()
    const y = normalizeForMatchKey(b).toLowerCase()
    if (!x || !y) return false
    return x === y || y.startsWith(`${x} `) || x.startsWith(`${y} `)
}

function artistMatchesLoose(a, b) {
    const tokens = normalizeForMatchKey(a)
        .toLowerCase()
        .split(' ')
        .filter(Boolean)
    const pool = new Set(
        normalizeForMatchKey(b)
            .toLowerCase()
            .split(' ')
            .filter(Boolean),
    )
    if (tokens.length === 0 || pool.size === 0) return false
    return tokens.every((t) => pool.has(t))
}

async function collectFlacs(dir, out, onFound = () => {}) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            await collectFlacs(abs, out, onFound)
        } else if (/\.flac$/i.test(entry.name)) {
            out.push(abs)
            if (out.length % 100 === 0) onFound(out.length)
        }
    }
}

const mostCommon = (values) => {
    const counts = new Map()
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1)
    return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null
}

// Apple call that waits out a rate limit (status shows "waiting") instead of failing.
function callApple(fn) {
    state.appleCalls += 1
    return withAppleRetry(fn, {
        shouldStop: () => state.stopRequested,
        onWait: (until) => {
            state.waitingUntil = until
            state.phase = until ? 'waiting' : 'matching'
            emit(true)
        },
    })
}

// One search + one album fetch for the whole folder: the album's tracks carry every
// ISRC and the album carries the UPC. Null when the album cannot be identified.
async function lookupAlbum(need, { deps, settings }) {
    const albumName = mostCommon(need.map((n) => n.meta.album))
    const artist = mostCommon(need.map((n) => n.meta.albumArtist || n.meta.artist))
    if (!albumName || !artist) return null
    const storefront = settings.storefront || 'us'
    const language = settings.language || 'en-US'
    const json = await callApple(() =>
        deps.searchCatalog({
            storefront,
            term: `${artist} ${albumName}`.trim(),
            types: 'albums',
            limit: 5,
            language,
        }),
    )
    const album = (json?.results?.albums?.data || []).find(
        (raw) =>
            nameMatchesLoose(albumName, raw.attributes?.name) &&
            artistMatchesLoose(artist, raw.attributes?.artistName),
    )
    if (!album?.id) return null
    const full = await callApple(() => deps.getAlbum({ storefront, id: album.id, language }))
    const data = full?.data?.[0]
    const tracks = (data?.relationships?.tracks?.data || []).map((t) => ({
        name: t.attributes?.name,
        isrc: t.attributes?.isrc,
        trackNumber: t.attributes?.trackNumber,
    }))
    return { upc: data?.attributes?.upc || album.attributes?.upc || null, tracks }
}

function matchFromAlbum(meta, info) {
    if (!info || !meta.title) return null
    const byName = info.tracks.filter((t) => t.isrc && nameMatchesLoose(meta.title, t.name))
    if (byName.length === 0) return null
    const number = Number.parseInt(String(meta.track || ''), 10)
    const track = byName.find((t) => t.trackNumber === number) || byName[0]
    return { isrc: track.isrc, upc: info.upc }
}

// Fallback for files the album lookup did not explain: one song search for the file.
async function resolveFile(meta, { deps, settings }) {
    const artist = meta.albumArtist || meta.artist
    const title = meta.title
    if (!artist || !title) return null

    const json = await callApple(() =>
        deps.searchCatalog({
            storefront: settings.storefront || 'us',
            term: `${artist} ${title}`.trim(),
            types: 'songs,albums',
            limit: 10,
            language: settings.language || 'en-US',
        }),
    )
    const songs = json?.results?.songs?.data || []
    const albums = json?.results?.albums?.data || []

    let bestSong = null
    let bestSongScore = -1
    for (const raw of songs) {
        const a = raw.attributes || {}
        let score = 0
        if (nameMatchesLoose(title, a.name)) score += 4
        if (artistMatchesLoose(artist, a.artistName)) score += 3
        if (meta.album && nameMatchesLoose(meta.album, a.albumName || '')) {
            score += 2
        }
        if (score > bestSongScore) {
            bestSongScore = score
            bestSong = raw
        }
    }
    if (bestSongScore < 7 || !bestSong?.attributes?.isrc) return null

    const songAlbumName = bestSong.attributes?.albumName || ''
    const albumNameCandidate = meta.album || songAlbumName
    let upc = null
    for (const raw of albums) {
        const a = raw.attributes || {}
        if (
            albumNameCandidate &&
            nameMatchesLoose(albumNameCandidate, a.name) &&
            artistMatchesLoose(artist, a.artistName)
        ) {
            upc = a.upc || null
            break
        }
    }

    return { isrc: bestSong.attributes.isrc, upc }
}

async function stampFile({ file, existing }, match) {
    if (!match) {
        state.noMatch += 1
        return
    }
    const needsIsrc = !existing.isrc && match.isrc
    const needsUpc = !existing.upc && match.upc
    if (!needsIsrc && !needsUpc) {
        state.skipped += 1
        return
    }
    if (!state.dryRun) {
        const ok = await writeAudioIdentityTags(file, {
            isrc: needsIsrc ? match.isrc : null,
            upc: needsUpc ? match.upc : null,
        })
        if (!ok) {
            state.failed += 1
            return
        }
        await fsp.utimes(path.dirname(file), new Date(), new Date()).catch(() => null)
    }
    state.stamped += 1
}

async function processFolder(dirFiles, ctx) {
    const need = []
    for (const file of dirFiles) {
        if (state.stopRequested) return
        state.current = path.relative(MUSIC_ROOT, file)
        const existing = await readAudioIdentityTags(file)
        if (existing.isrc && existing.upc) {
            state.scanned += 1
            state.skipped += 1
            emit()
            continue
        }
        need.push({ file, existing })
    }
    if (need.length === 0) return

    for (const n of need) n.meta = await readAudioMetaTags(n.file)

    let info = null
    try {
        info = await lookupAlbum(need, ctx)
    } catch (err) {
        if (state.stopRequested) return
        // Not rate limiting (that was waited out): fall back to per-file lookups below.
        state.error = err.message || 'album lookup failed'
    }

    for (const n of need) {
        if (state.stopRequested) return
        state.current = path.relative(MUSIC_ROOT, n.file)
        try {
            const match = matchFromAlbum(n.meta, info) || (await resolveFile(n.meta, ctx))
            await stampFile(n, match)
        } catch (err) {
            if (state.stopRequested && isAppleRateLimited(err)) return
            state.failed += 1
            state.error = err.message || 'backfill error'
        }
        state.scanned += 1
        emit()
    }
}

async function runBackfill(deps) {
    try {
        const settings = await deps.readSettings()
        state.phase = 'scanning'
        const files = []
        await collectFlacs(MUSIC_ROOT, files, (found) => {
            state.total = found
            emit()
        })
        state.total = files.length
        const folders = new Map()
        for (const file of files) {
            const dir = path.dirname(file)
            if (!folders.has(dir)) folders.set(dir, [])
            folders.get(dir).push(file)
        }
        state.albumsTotal = folders.size
        state.phase = 'matching'
        emit(true)

        for (const dirFiles of folders.values()) {
            if (state.stopRequested) break
            await processFolder(dirFiles, { deps, settings })
            state.albumsDone += 1
            emit()
        }
    } catch (err) {
        state.error = err.message || 'backfill failed'
    } finally {
        state.running = false
        state.phase = 'done'
        state.waitingUntil = null
        state.current = null
        state.finishedAt = deps.now()
        if (!state.dryRun && state.stamped > 0) {
            invalidateLibraryCache()
        }
        emit(true)
    }
}

export async function startTagBackfill({ dryRun = false, deps = defaultDeps } = {}) {
    if (state.running) {
        const err = new Error('a tag backfill is already running')
        err.statusCode = 409
        throw err
    }
    state.running = true
    state.phase = 'scanning'
    state.dryRun = Boolean(dryRun)
    state.scanned = 0
    state.total = 0
    state.albumsDone = 0
    state.albumsTotal = 0
    state.appleCalls = 0
    state.waitingUntil = null
    state.stamped = 0
    state.skipped = 0
    state.noMatch = 0
    state.failed = 0
    state.current = null
    state.startedAt = deps.now()
    state.finishedAt = null
    state.stopRequested = false
    state.error = null
    emit(true)

    runInLane('background', () => runBackfill(deps)).catch(() => {
        state.running = false
        state.finishedAt = deps.now()
        emit(true)
    })
    return status()
}
