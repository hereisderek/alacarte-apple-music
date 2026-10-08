import crypto from 'node:crypto'

import { emitEvent } from './eventBus.mjs'
import { pickBestMatch } from './matcher.mjs'
import {
  enqueueSongDownload,
  exportPlaylistM3u,
  getDownloadJob,
  searchSongs,
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
const POLL_INTERVAL_MS = 2000
const exportInFlight = new Set()

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

export async function createImportSession({ title, tracks = [], warnings = [], language }) {
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

async function doSearch(query, mode, language) {
  if (!query || !query.trim()) return []
  await paceNextSearch()
  if (mode === 'subsonic') {
    return await searchSubsonicSongs({ query: query.trim(), limit: 5 })
  }
  return await searchSongs({ q: query.trim(), limit: 5, language })
}

async function runMatching(session) {
  for (const item of session.items) {
    try {
      const mode = getInternalConfig().mode

      const partA = cleanTitleRemarks(item.partA || item.parsedTitle)
      const partB = cleanTitleRemarks(item.partB || (item.parsedArtists && item.parsedArtists[0]))

      let candidates = []
      let matchResult = null

      if (partA && partB) {
        // Query 1: Forward (partA as song title, partB as artist/album)
        const q1 = `${partA} ${partB}`.trim()
        candidates = await doSearch(q1, mode, session.language)
        matchResult = pickBestMatch(candidates, {
          query: q1,
          title: partA,
          parsedArtists: [partB],
        })

        // Query 2: Reverse (if not found, reverse it and search again after paced delay)
        if (matchResult.status !== 'matched') {
          const q2 = `${partB} ${partA}`.trim()
          const candidates2 = await doSearch(q2, mode, session.language)
          if (candidates2.length > 0) {
            const matchResult2 = pickBestMatch(candidates2, {
              query: q2,
              title: partB,
              parsedArtists: [partA],
            })
            if (matchResult2.status === 'matched') {
              candidates = candidates2
              matchResult = matchResult2
            } else if (candidates.length === 0) {
              candidates = candidates2
            }
          }
        }

        // Query 3: Fallback (if still not found, search title candidate alone)
        if (matchResult.status !== 'matched') {
          const titleToTry = cleanTitleRemarks(item.parsedTitle) || partB || partA
          if (titleToTry) {
            const fallbackCandidates = await doSearch(titleToTry, mode, session.language)
            if (fallbackCandidates.length > 0) {
              const fallbackResult = pickBestMatch(fallbackCandidates, {
                query: titleToTry,
                title: titleToTry,
                parsedArtists: [],
              })
              if (fallbackResult.status === 'matched') {
                candidates = fallbackCandidates
                matchResult = fallbackResult
              } else if (candidates.length === 0) {
                candidates = fallbackCandidates
              }
            }
          }
        }
      } else {
        // Single search term with no delimiters
        const q = cleanTitleRemarks(item.parsedTitle || item.raw)
        candidates = await doSearch(q, mode, session.language)
        matchResult = pickBestMatch(candidates, {
          query: q,
          title: q,
          parsedArtists: [],
        })
      }

      item.candidates = candidates || []

      if (matchResult && matchResult.status === 'matched' && matchResult.chosen) {
        enqueueItemForDownload(session, item, matchResult.chosen)
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

function enqueueItemForDownload(session, item, chosen) {
  const mode = getInternalConfig().mode
  const songId = chosen.id || chosen.songId
  item.status = 'waiting'
  item.chosenSongId = songId
  item.chosenAlbumId = chosen.albumId || null
  item.chosenName = chosen.name
  item.chosenArtist = chosen.artistName
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
              await waitForAlacarteJob(session, item)
            } else {
              item.status = 'done'
              item.message = 'Queued in backend'
              touch(session)
            }
          } catch (err) {
            if (err.status === 409) {
              item.status = 'done'
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
        item.error = err.message
        touch(session)
      } finally {
        activeDownload = null
        broadcastQueuePositions()
      }

      // 1-second pace gap between downloads
      await sleep(1000)
    }
  } finally {
    drainingDownloadQueue = false
    activeDownload = null
    broadcastQueuePositions()
  }
}

async function waitForAlacarteJob(session, item) {
  const start = Date.now()
  const TIMEOUT_MS = 300_000 // 5 minutes max
  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS)
    let job
    try {
      job = await getDownloadJob(item.downloadJobId)
    } catch {
      continue
    }
    if (!job) continue
    if (job.status === 'done') {
      item.status = 'done'
      item.message = null
      touch(session)
      maybeExportPlaylist(session)
      return
    }
    if (job.status === 'failed') {
      item.status = 'failed'
      item.error = job.error || 'download failed'
      touch(session)
      return
    }
  }
  item.message = 'Still processing in backend'
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

  enqueueItemForDownload(session, item, chosen)
  return session
}
