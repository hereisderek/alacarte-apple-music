import crypto from 'node:crypto'

import { emitEvent } from './eventBus.mjs'
import { pickBestMatch } from './matcher.mjs'
import {
  enqueueSongDownload,
  exportPlaylistM3u,
  getDownloadJob,
  searchSongs,
} from './backendClient.mjs'

// In-memory only: sessions live for the process's uptime, not across a
// restart. That's fine for "paste a list, watch it import" — a persistence
// layer is real scope, add it if imports need to survive a redeploy.
const sessions = new Map()
const POLL_INTERVAL_MS = 3000
const exportInFlight = new Set()

// Only one import's *matching* phase (the part that hammers Apple's
// catalog-search quota) runs at a time — confirmed live that a handful of
// concurrent/rapid-fire batches exhausts it in under a minute even with the
// backend's own request spacing. Everything else (download-job polling,
// manual picks) doesn't compete for that quota, so it isn't gated by this.
const matchQueue = []
let draining = false

function shortId() {
  return crypto.randomBytes(6).toString('base64url')
}

function publicSession(session) {
  const idx = matchQueue.indexOf(session.id)
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    // 0 = actively matching, >0 = number of imports ahead of this one,
    // undefined = matching already finished (tracks are queued/notfound).
    queuePosition: idx === -1 ? undefined : idx,
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
    done: 0,
    failed: 0,
    notfound: 0,
  }
  for (const item of session.items) {
    if (item.status in counts) counts[item.status] += 1
    else counts.pending += 1
  }
  counts.processed = session.items.length - counts.pending
  counts.added = counts.queued + counts.done
  return counts
}

function touch(session) {
  session.updatedAt = Date.now()
  emitEvent(session.id, publicSession(session))
}

function touchQueued() {
  for (const id of matchQueue) {
    const session = sessions.get(id)
    if (session) touch(session)
  }
}

export function getSession(id) {
  return sessions.get(id) || null
}

export { publicSession }

export async function createImportSession({ title, tracks, warnings }) {
  let id = shortId()
  while (sessions.has(id)) id = shortId() // vanishingly unlikely, cheap to guard anyway

  const session = {
    id,
    title: title || 'Imported playlist',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    warnings: warnings || [],
    items: tracks.map((t, index) => ({
      index,
      raw: t.raw || [t.title, ...(t.artists || [])].filter(Boolean).join(' - '),
      parsedTitle: t.title,
      parsedArtists: t.artists || [],
      status: 'pending',
      candidates: [],
      chosenSongId: null,
      chosenName: null,
      chosenArtist: null,
      downloadJobId: null,
      message: null,
      error: null,
    })),
  }
  sessions.set(id, session)
  matchQueue.push(id)
  touchQueued()
  drainMatchQueue()
  return session
}

async function drainMatchQueue() {
  if (draining) return
  draining = true
  try {
    while (matchQueue.length > 0) {
      const id = matchQueue[0]
      const session = sessions.get(id)
      if (session) {
        touch(session) // now at position 0 ("actively matching")
        try {
          await runMatching(session)
        } catch (err) {
          console.error('[import] matching pass failed:', err.message)
        }
      }
      matchQueue.shift()
      touchQueued()
    }
  } finally {
    draining = false
  }
}

// Small gap between searches so a big batch doesn't burst straight into
// Apple's catalog-search rate limit. The backend's own /api/internal/search
// spacing (see backend/lib/requestSpacer.mjs, INTERNAL_SEARCH_MIN_INTERVAL_MS)
// is the primary defense now; this plus backendClient's 429 retry are extra
// margin, not the only guard.
const SEARCH_PACING_MS = Math.max(0, Number(process.env.IMPORTER_SEARCH_PACING_MS) || 500)

async function runMatching(session) {
  for (const item of session.items) {
    try {
      const query = [item.parsedTitle, ...(item.parsedArtists || [])].filter(Boolean).join(' ')
      const candidates = await searchSongs({ q: query, limit: 5 })
      const result = pickBestMatch(candidates, { query, parsedArtists: item.parsedArtists })
      item.candidates = result.candidates
      if (result.status === 'matched') {
        await queueItem(session, item, result.chosen)
      } else {
        item.status = result.status
        touch(session)
      }
      await new Promise((resolve) => setTimeout(resolve, SEARCH_PACING_MS))
    } catch (err) {
      item.status = 'failed'
      item.error = err.message
      touch(session)
    }
  }
}

async function queueItem(session, item, chosen) {
  try {
    const job = await enqueueSongDownload({ songId: chosen.id, albumId: chosen.albumId })
    item.status = 'queued'
    item.chosenSongId = chosen.id
    item.chosenName = chosen.name
    item.chosenArtist = chosen.artistName
    item.downloadJobId = job?.id || null
    touch(session)
    if (item.downloadJobId) trackJob(session, item)
  } catch (err) {
    if (err.status === 409) {
      item.status = 'done'
      item.chosenSongId = chosen.id
      item.chosenName = chosen.name
      item.chosenArtist = chosen.artistName
      item.message = 'Already in library'
      touch(session)
      maybeExportPlaylist(session)
    } else {
      item.status = 'failed'
      item.error = err.message
      touch(session)
    }
  }
}

function trackJob(session, item) {
  const timer = setInterval(async () => {
    let job
    try {
      job = await getDownloadJob(item.downloadJobId)
    } catch {
      return // transient backend hiccup; keep polling
    }
    if (!job) return
    if (job.status === 'done') {
      clearInterval(timer)
      item.status = 'done'
      touch(session)
      maybeExportPlaylist(session)
    } else if (job.status === 'failed') {
      clearInterval(timer)
      item.status = 'failed'
      item.error = job.error || 'download failed'
      touch(session)
    }
  }, POLL_INTERVAL_MS)
  timer.unref?.()
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

// Manual pick for a not-found item (or a re-search override). Works whether
// or not this session's own matching phase has finished — it targets one
// item directly and doesn't touch the matching queue.
export async function selectCandidate(sessionId, itemIndex, chosen) {
  const session = sessions.get(sessionId)
  if (!session) throw Object.assign(new Error('session not found'), { status: 404 })
  const item = session.items[itemIndex]
  if (!item) throw Object.assign(new Error('item not found'), { status: 404 })
  await queueItem(session, item, chosen)
  return session
}
