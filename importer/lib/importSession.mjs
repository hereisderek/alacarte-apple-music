import crypto from 'node:crypto'

import { emitEvent } from './eventBus.mjs'
import { pickBestMatch } from './matcher.mjs'
import {
  enqueueSongDownload,
  exportPlaylistM3u,
  getDownloadJob,
  searchSongs,
  searchSongsByIsrc,
} from './backendClient.mjs'
import {
  downloadSubsonicSongStream,
  searchSubsonicSongs,
} from './subsonicClient.mjs'
import { getInternalConfig } from './configStore.mjs'
import { cleanTitleRemarks } from '../parsers/plaintext.mjs'

// In-memory only: sessions live for the process's uptime, not across a
// restart.
const sessions = new Map()
const exportInFlight = new Set()
const DOWNLOAD_GAP_MS = Math.max(0, Number(process.env.IMPORTER_DOWNLOAD_GAP_MS ?? 1000))

// Only one import's *matching* phase runs at a time to prevent search quota spikes.
const matchQueue = []
let drainingMatchQueue = false

// Unified Global Download Queue across all sessions and both modes.
// Only ONE download is processed at a time globally.
const globalDownloadQueue = []
let activeDownload = null
let drainingDownloadQueue = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A source (parser) that knows a track's ISRC can set `isrc` on it; such tracks are
// looked up 25 at a time instead of with a text search each.
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/
const ISRC_BATCH = 25
function normalizeIsrc(value) {
  const v = String(value || '').trim().toUpperCase()
  return ISRC_RE.test(v) ? v : null
}

// The details of a candidate worth showing; whatever else a backend sends is dropped.
// All of it comes from the search results the importer already gets.
const CANDIDATE_FIELDS = [
  'id', 'name', 'artistName', 'albumName', 'albumId', 'artistId', 'durationMs', 'isrc',
  'artworkTemplate', 'bitRate', 'suffix', 'contentType', 'sizeBytes', 'year', 'genre',
  'trackNumber', 'discNumber', 'samplingRate', 'bitDepth', 'channelCount',
]
function candidateInfo(c) {
  const out = {}
  for (const key of CANDIDATE_FIELDS) if (c && c[key] !== undefined && c[key] !== null) out[key] = c[key]
  if (out.id === undefined && c?.songId) out.id = c.songId
  return out
}

function shortId() {
  return crypto.randomBytes(6).toString('base64url')
}

export function getOtherSongsAheadForSession(sessionId) {
  const firstIndex = globalDownloadQueue.findIndex((e) => e.sessionId === sessionId)
  if (firstIndex === -1) {
    return 0
  }
  let count = firstIndex
  if (activeDownload && activeDownload.sessionId !== sessionId) {
    count += 1
  }
  return count
}

function publicSession(session) {
  const matchIdx = matchQueue.indexOf(session.id)
  const otherSongsAhead = getOtherSongsAheadForSession(session.id)
  return {
    id: session.id,
    title: session.title,
    language: session.language || null,
    sources: session.sources || [],
    createdAt: session.createdAt,
    queuePosition: matchIdx === -1 ? undefined : matchIdx,
    otherSongsAhead,
    counts: computeCounts(session),
    items: session.items.map((item) => ({ ...item })),
    warnings: session.warnings || [],
  }
}

function computeCounts(session) {
  const counts = {
    total: session.items.length,
    processed: 0,
    added: 0,
    pending: 0,
    queued: 0,
    waiting: 0,
    downloading: 0,
    done: 0,
    failed: 0,
    notfound: 0,
  }
  for (const item of session.items) {
    if (item.status in counts) counts[item.status] += 1
    else counts.pending += 1
  }
  counts.processed = session.items.length - counts.pending
  counts.added = counts.queued + counts.waiting + counts.downloading + counts.done
  return counts
}

function touch(session) {
  session.updatedAt = Date.now()
  emitEvent(session.id, publicSession(session))
}

function touchQueuedMatches() {
  for (const id of matchQueue) {
    const session = sessions.get(id)
    if (session) touch(session)
  }
}

export function getSession(id) {
  return sessions.get(id) || null
}

export { publicSession }

export function getMaxTracksPerImport() {
  const v = Number(process.env.IMPORTER_MAX_TRACKS_PER_IMPORT || process.env.IMPORTER_MAX_TRACKS)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

export function getGlobalQueueStatus() {
  return {
    active: activeDownload ? 1 : 0,
    waiting: globalDownloadQueue.length,
    activeSong: activeDownload ? `${activeDownload.chosenName} - ${activeDownload.chosenArtist}` : null,
  }
}

export async function createImportSession({ title, tracks = [], warnings = [], language, sources = [] }) {
  let id = shortId()
  while (sessions.has(id)) id = shortId()

  const maxTracks = getMaxTracksPerImport()
  let finalTracks = tracks
  const finalWarnings = [...(warnings || [])]
  if (maxTracks > 0 && tracks.length > maxTracks) {
    finalWarnings.unshift(
      `Import exceeded maximum queue limit of ${maxTracks} songs (received ${tracks.length}). Only the first ${maxTracks} songs will be processed.`
    )
    finalTracks = tracks.slice(0, maxTracks)
  }

  const session = {
    id,
    title: title || 'Imported playlist',
    language: language || null,
    sources,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    warnings: finalWarnings,
    items: finalTracks.map((t, index) => ({
      index,
      raw: t.raw || [t.title, ...(t.artists || [])].filter(Boolean).join(' - '),
      parsedTitle: t.title,
      parsedArtists: t.artists || [],
      partA: t.partA || t.title,
      partB: t.partB !== undefined ? t.partB : ((t.artists && t.artists[0]) || null),
      isrc: normalizeIsrc(t.isrc),
      source: t.source || null,
      matchedBy: null,
      matchedQuery: null,
      candidateCount: 0,
      chosen: null,
      inLibrary: false,
      job: null,
      matchedAt: null,
      finishedAt: null,
      status: 'pending',
      queuePosition: null,
      candidates: [],
      chosenSongId: null,
      chosenAlbumId: null,
      chosenName: null,
      chosenArtist: null,
      downloadJobId: null,
      message: null,
      error: null,
    })),
  }
  sessions.set(id, session)
  matchQueue.push(id)
  touchQueuedMatches()
  drainMatchQueue()
  return session
}

async function drainMatchQueue() {
  if (drainingMatchQueue) return
  drainingMatchQueue = true
  try {
    while (matchQueue.length > 0) {
      const id = matchQueue[0]
      const session = sessions.get(id)
      if (session) {
        touch(session)
        try {
          await runMatching(session)
        } catch (err) {
          console.error('[import] matching pass failed:', err.message)
        }
      }
      matchQueue.shift()
      touchQueuedMatches()
    }
  } finally {
    drainingMatchQueue = false
  }
}

// Start-to-start rate pacer: counts any backend/network processing time
// towards the required interval so queries are spaced evenly without redundant delay.
let lastSearchDispatchTime = 0

async function paceNextSearch() {
  const cfg = getInternalConfig()
  const intervalMs = Math.max(100, Number(cfg.searchIntervalMs) || 1500)
  const now = Date.now()
  const elapsed = now - lastSearchDispatchTime
  if (lastSearchDispatchTime > 0 && elapsed < intervalMs) {
    await sleep(intervalMs - elapsed)
  }
  lastSearchDispatchTime = Date.now()
}

// Search results by query, so the same query (a title repeated in a list, or the same
// playlist imported again) is not sent twice. Short lived: results change.
const QUERY_CACHE_TTL_MS = 30 * 60 * 1000
const QUERY_CACHE_MAX = 500
const queryCache = new Map()

// While the backend waits out an Apple rate limit, say so on the item instead of looking stuck.
function waitNotifier(session, item) {
  return (delayMs) => {
    if (!item) return
    const minutes = Math.max(1, Math.round(delayMs / 60_000))
    item.message = `Apple is rate limiting this server, retrying in about ${minutes} min…`
    touch(session)
  }
}

async function doSearch(query, mode, language, ctx = {}) {
  if (!query || !query.trim()) return []
  const q = query.trim()
  const key = `${mode}|${language || ''}|${q.toLowerCase()}`
  const hit = queryCache.get(key)
  if (hit && Date.now() - hit.at < QUERY_CACHE_TTL_MS) return hit.candidates
  await paceNextSearch()
  let candidates
  if (mode === 'subsonic') {
    candidates = await searchSubsonicSongs({ query: q, limit: 5 })
  } else {
    candidates = await searchSongs({ q, limit: 5, language, onWait: waitNotifier(ctx.session, ctx.item) })
  }
  if (ctx.item?.message?.startsWith('Apple is rate limiting')) ctx.item.message = null
  queryCache.delete(key)
  queryCache.set(key, { at: Date.now(), candidates })
  while (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value)
  return candidates
}

// Tracks with a known ISRC: 25 per request. Whatever Apple does not return (or any
// failure) is left pending and goes through the normal text search.
async function matchByIsrc(session) {
  const todo = session.items.filter((i) => i.isrc && i.status === 'pending')
  for (let i = 0; i < todo.length; i += ISRC_BATCH) {
    const chunk = todo.slice(i, i + ISRC_BATCH)
    let songs
    try {
      await paceNextSearch()
      songs = await searchSongsByIsrc({
        isrcs: [...new Set(chunk.map((c) => c.isrc))],
        language: session.language,
        onWait: waitNotifier(session, chunk[0]),
      })
    } catch (err) {
      console.error('[import] ISRC lookup failed, falling back to text search:', err.message)
      continue
    } finally {
      for (const c of chunk) if (c.message?.startsWith('Apple is rate limiting')) c.message = null
    }
    const byIsrc = new Map()
    for (const song of songs) if (song?.isrc && !byIsrc.has(song.isrc)) byIsrc.set(song.isrc, song)
    for (const item of chunk) {
      const song = byIsrc.get(item.isrc)
      if (!song) continue
      item.candidates = [song]
      item.candidateCount = 1
      enqueueItemForDownload(session, item, song, { matchedBy: 'isrc', query: item.isrc })
    }
  }
}

async function runMatching(session) {
  const mode = getInternalConfig().mode
  if (mode !== 'subsonic') await matchByIsrc(session)

  for (const item of session.items) {
    if (item.status !== 'pending') continue
    try {
      const ctx = { session, item }
      const partA = cleanTitleRemarks(item.partA || item.parsedTitle)
      const partB = cleanTitleRemarks(item.partB || (item.parsedArtists && item.parsedArtists[0]))

      let candidates = []
      let matchResult = null
      let how = { matchedBy: 'search', query: null }

      if (partA && partB) {
        // Query 1: "<A> <B>". Apple's search ignores word order, so the same results
        // are tried with the roles swapped (B as the title) before spending a second
        // request.
        const q1 = `${partA} ${partB}`.trim()
        how = { matchedBy: 'search', query: q1 }
        candidates = await doSearch(q1, mode, session.language, ctx)
        matchResult = pickBestMatch(candidates, {
          query: q1,
          title: partA,
          parsedArtists: [partB],
        })
        if (matchResult.status !== 'matched' && candidates.length > 0) {
          const swapped = pickBestMatch(candidates, {
            query: q1,
            title: partB,
            parsedArtists: [partA],
          })
          if (swapped.status === 'matched') {
            matchResult = swapped
            how = { matchedBy: 'search-swapped', query: q1 }
          }
        }

        // Query 2 (only if still not found): the title on its own.
        if (matchResult.status !== 'matched') {
          const titleToTry = cleanTitleRemarks(item.parsedTitle) || partB || partA
          if (titleToTry && titleToTry.toLowerCase() !== q1.toLowerCase()) {
            const fallbackCandidates = await doSearch(titleToTry, mode, session.language, ctx)
            if (fallbackCandidates.length > 0) {
              const fallbackResult = pickBestMatch(fallbackCandidates, {
                query: titleToTry,
                title: titleToTry,
                parsedArtists: [],
              })
              if (fallbackResult.status === 'matched') {
                candidates = fallbackCandidates
                matchResult = fallbackResult
                how = { matchedBy: 'title-only', query: titleToTry }
              } else if (candidates.length === 0) {
                candidates = fallbackCandidates
              }
            }
          }
        }
      } else {
        // Single search term with no delimiters
        const q = cleanTitleRemarks(item.parsedTitle || item.raw)
        how = { matchedBy: 'search', query: q }
        candidates = await doSearch(q, mode, session.language, ctx)
        matchResult = pickBestMatch(candidates, {
          query: q,
          title: q,
          parsedArtists: [],
        })
      }

      item.candidates = candidates || []
      item.candidateCount = item.candidates.length

      if (matchResult && matchResult.status === 'matched' && matchResult.chosen) {
        enqueueItemForDownload(session, item, matchResult.chosen, how)
      } else {
        item.status = 'notfound'
        touch(session)
      }
    } catch (err) {
      item.status = 'failed'
      item.error = err.message
      touch(session)
    }
  }
}

function broadcastQueuePositions() {
  const touchedSessions = new Set()

  if (activeDownload) {
    const s = sessions.get(activeDownload.sessionId)
    if (s) {
      const it = s.items[activeDownload.itemIndex]
      if (it && it.status !== 'done' && it.status !== 'failed') {
        it.status = 'downloading'
        it.queuePosition = 0
        it.message = 'Downloading…'
        touchedSessions.add(s)
      }
    }
  }

  for (let i = 0; i < globalDownloadQueue.length; i++) {
    const entry = globalDownloadQueue[i]
    const s = sessions.get(entry.sessionId)
    if (!s) continue
    const it = s.items[entry.itemIndex]
    if (!it || it.status === 'done' || it.status === 'failed') continue
    const ahead = i + (activeDownload ? 1 : 0)
    it.status = 'waiting'
    it.queuePosition = ahead
    it.message = 'Waiting'
    touchedSessions.add(s)
  }

  for (const s of touchedSessions) {
    touch(s)
  }
}

function enqueueItemForDownload(session, item, chosen, how = {}) {
  const mode = getInternalConfig().mode
  const songId = chosen.id || chosen.songId
  item.status = 'waiting'
  item.chosenSongId = songId
  item.chosenAlbumId = chosen.albumId || null
  item.chosenName = chosen.name
  item.chosenArtist = chosen.artistName
  item.chosen = candidateInfo(chosen)
  item.matchedBy = how.matchedBy || null
  item.matchedQuery = how.query || null
  item.matchedAt = Date.now()
  if (chosen.name) item.parsedTitle = chosen.name
  if (chosen.artistName) item.parsedArtists = [chosen.artistName]

  globalDownloadQueue.push({
    sessionId: session.id,
    itemIndex: item.index,
    mode,
    chosenSongId: songId,
    chosenAlbumId: chosen.albumId || null,
    chosenName: chosen.name,
    chosenArtist: chosen.artistName,
  })

  broadcastQueuePositions()
  drainGlobalDownloadQueue()
}

async function drainGlobalDownloadQueue() {
  if (drainingDownloadQueue) return
  drainingDownloadQueue = true

  try {
    while (globalDownloadQueue.length > 0) {
      activeDownload = globalDownloadQueue.shift()
      const session = sessions.get(activeDownload.sessionId)
      if (!session) {
        activeDownload = null
        broadcastQueuePositions()
        continue
      }
      const item = session.items[activeDownload.itemIndex]
      if (!item) {
        activeDownload = null
        broadcastQueuePositions()
        continue
      }

      item.status = 'downloading'
      item.queuePosition = 0
      item.message = 'Downloading…'
      touch(session)
      broadcastQueuePositions()

      try {
        if (activeDownload.mode === 'subsonic') {
          await downloadSubsonicSongStream(activeDownload.chosenSongId)
          item.status = 'done'
          item.finishedAt = Date.now()
          item.message = 'Downloaded via Subsonic'
          touch(session)
          maybeExportPlaylist(session)
        } else {
          // ALACarte mode
          try {
            const job = await enqueueSongDownload({
              songId: activeDownload.chosenSongId,
              albumId: activeDownload.chosenAlbumId,
            })
            item.downloadJobId = job?.id || null
            if (item.downloadJobId) {
              // The backend runs the download; the importer moves on to the next track
              // and follows the job in the background (see trackJob).
              item.status = 'queued'
              item.queuePosition = null
              item.message = 'Queued in backend'
              item.job = jobInfo(job)
              touch(session)
              trackJob(session, item, item.downloadJobId)
            } else {
              item.status = 'done'
              item.finishedAt = Date.now()
              item.message = 'Queued in backend'
              touch(session)
            }
          } catch (err) {
            // The backend answers "Already in library" (as a 409, or a plain error with
            // that text) when the track is on disk already.
            if (err.status === 409 || /already in library/i.test(err.message || '')) {
              item.status = 'done'
              item.inLibrary = true
              item.finishedAt = Date.now()
              item.message = 'Already in library'
              touch(session)
              maybeExportPlaylist(session)
            } else {
              throw err
            }
          }
        }
      } catch (err) {
        item.status = 'failed'
        item.finishedAt = Date.now()
        item.error = err.message
        touch(session)
      } finally {
        activeDownload = null
        broadcastQueuePositions()
      }

      // pace gap between downloads (1 s unless IMPORTER_DOWNLOAD_GAP_MS says otherwise)
      await sleep(DOWNLOAD_GAP_MS)
    }
  } finally {
    drainingDownloadQueue = false
    activeDownload = null
    broadcastQueuePositions()
  }
}

// What the backend's download job says about itself (requested quality, progress, where it
// went); shown next to the track while it runs and after.
function jobInfo(job) {
  return {
    status: job.status || null,
    progress: typeof job.progress === 'number' ? job.progress : null,
    quality: job.quality || null,
    variant: job.variant || null,
    currentTrack: job.currentTrack || null,
    message: job.message || null,
    finalDir: job.finalDir || null,
    unavailable: Boolean(job.unavailable),
  }
}

// ---- following backend download jobs ----
// Each enqueued track has a job in the backend. One timer polls them all (a few at a time)
// and moves the item through queued -> downloading -> done/failed, with the job's progress
// and quality on the item. Jobs the backend stops knowing about, or that take longer than
// JOB_GIVE_UP_MS, are dropped from tracking.
const JOB_POLL_MS = Math.max(200, Number(process.env.IMPORTER_JOB_POLL_MS) || 3000)
const JOB_GIVE_UP_MS = 6 * 60 * 60 * 1000
const JOB_POLL_PARALLEL = 5
const trackedJobs = new Map() // jobId -> { sessionId, itemIndex, since, misses }
let jobTimer = null
let pollingJobs = false

function trackJob(session, item, jobId) {
  trackedJobs.set(jobId, { sessionId: session.id, itemIndex: item.index, since: Date.now(), misses: 0 })
  if (!jobTimer) {
    jobTimer = setInterval(pollTrackedJobs, JOB_POLL_MS)
    jobTimer.unref?.()
  }
}

async function pollTrackedJobs() {
  if (pollingJobs) return
  pollingJobs = true
  try {
    const entries = [...trackedJobs.entries()]
    for (let i = 0; i < entries.length; i += JOB_POLL_PARALLEL) {
      await Promise.all(entries.slice(i, i + JOB_POLL_PARALLEL).map(([id, t]) => pollJob(id, t)))
    }
  } finally {
    pollingJobs = false
    if (trackedJobs.size === 0 && jobTimer) {
      clearInterval(jobTimer)
      jobTimer = null
    }
  }
}

async function pollJob(jobId, tracked) {
  const session = sessions.get(tracked.sessionId)
  const item = session?.items[tracked.itemIndex]
  if (!item) {
    trackedJobs.delete(jobId)
    return
  }
  let job
  try {
    job = await getDownloadJob(jobId)
  } catch {
    return // backend unreachable for now; try again next round
  }
  if (!job) {
    tracked.misses += 1
    if (tracked.misses >= 5) {
      trackedJobs.delete(jobId)
      item.status = 'done'
      item.finishedAt = Date.now()
      item.message = 'Queued in backend (no further status available)'
      touch(session)
    }
    return
  }
  tracked.misses = 0
  item.job = jobInfo(job)
  if (job.status === 'done') {
    trackedJobs.delete(jobId)
    item.status = 'done'
    item.finishedAt = Date.now()
    item.message = null
    touch(session)
    maybeExportPlaylist(session)
    return
  }
  if (job.status === 'failed' || job.cancelled) {
    trackedJobs.delete(jobId)
    item.status = 'failed'
    item.finishedAt = Date.now()
    item.error = job.error || (job.cancelled ? 'download cancelled' : 'download failed')
    touch(session)
    return
  }
  if (job.status === 'running') {
    item.status = 'downloading'
    item.message = null
  } else {
    item.status = 'queued'
    item.message = 'Queued in backend'
  }
  if (Date.now() - tracked.since > JOB_GIVE_UP_MS) {
    trackedJobs.delete(jobId)
    item.message = 'Still processing in backend'
  }
  touch(session)
}

function maybeExportPlaylist(session) {
  if (exportInFlight.has(session.id)) return
  const doneTracks = session.items.filter((i) => i.status === 'done' && i.chosenName)
  if (doneTracks.length === 0) return
  exportInFlight.add(session.id)
  exportPlaylistM3u({
    title: session.title,
    tracks: doneTracks.map((i) => ({ name: i.chosenName, artistName: i.chosenArtist })),
  })
    .catch((err) => console.error('[import] playlist export failed:', err.message))
    .finally(() => exportInFlight.delete(session.id))
}

// Manual pick for a not-found item or search override
export async function selectCandidate(sessionId, itemIndex, chosen) {
  const session = sessions.get(sessionId)
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 })
  const item = session.items[itemIndex]
  if (!item) throw Object.assign(new Error('item not found'), { status: 404 })

  enqueueItemForDownload(session, item, chosen, { matchedBy: 'manual' })
  return session
}
