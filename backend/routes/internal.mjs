import express from 'express'
import path from 'node:path'

import { searchCatalog } from '../lib/appleApi.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { enqueueSong, getJob, listJobs } from '../lib/queue.mjs'
import { writePlaylistM3U } from '../lib/playlistExport.mjs'
import { getMusicRoot, makeSongKey, scanLibraryOnce } from '../lib/libraryIndex.mjs'
import { normalizeForMatchKey } from '../lib/libraryMatchKey.mjs'
import { createSpacer } from '../lib/requestSpacer.mjs'
import { probeWrapperPorts } from '../lib/wrapperHealth.mjs'
import { getBearerToken } from '../lib/appleToken.mjs'

function toAppleLanguage(code) {
  if (!code) return 'en-US'
  return String(code).trim() || 'en-US'
}

// Minimal surface for the separate public import service (importer/) to call
// server-to-server. Guarded by requireInternalKey(), not the owner session —
// see requireInternalKey.mjs and its mount point in server.mjs.
export const internalRouter = express.Router()

// Deliberately conservative — see requestSpacer.mjs for why. Override with
// INTERNAL_SEARCH_MIN_INTERVAL_MS if this turns out to still be too fast (or
// needlessly slow) for your account/storefront.
const SEARCH_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.INTERNAL_SEARCH_MIN_INTERVAL_MS) || 1500,
)
const spacedSearch = createSpacer(SEARCH_MIN_INTERVAL_MS)

function mapSong(x) {
  const songUrl = x.attributes?.url || ''
  const m = songUrl.match(/\/album\/(?:[^/]+\/)?(\d+)(?:\?|$)/)
  return {
    id: x.id,
    name: x.attributes?.name,
    artistName: x.attributes?.artistName,
    artistId: x.relationships?.artists?.data?.[0]?.id || null,
    albumId: m ? m[1] : null,
    albumName: x.attributes?.albumName,
    durationMs: x.attributes?.durationInMillis,
    artworkTemplate: x.attributes?.artwork?.url || null,
    isrc: x.attributes?.isrc || null,
  }
}

// Resolves {name, artistName, version?} entries to on-disk file paths using
// version-aware matching against scanLibraryOnce() results.
async function resolveTracksToLocalPaths(trackIndex) {
  if (!Array.isArray(trackIndex) || trackIndex.length === 0) return []
  const index = await scanLibraryOnce()
  const musicRoot = getMusicRoot()
  const absPaths = []
  for (const track of trackIndex) {
    if (!track?.name) continue
    const wanted = track.version || null
    const key = track.artistName
      ? makeSongKey(track.artistName, track.name)
      : null

    let candidates = key
      ? (index.songVersionPaths?.get(key) || []).slice()
      : []
    if (candidates.length === 0) {
      const suffix = `::${normalizeForMatchKey(track.name).toLowerCase()}`
      for (const [songKey, versions] of index.songVersionPaths || []) {
        if (!songKey.endsWith(suffix)) continue
        for (const v of versions) candidates.push(v)
      }
    }
    const seen = new Set()
    candidates = candidates.filter((c) => {
      if (seen.has(c.rel)) return false
      seen.add(c.rel)
      return true
    })
    if (candidates.length === 0) continue

    let rel = null
    if (wanted) {
      const match = candidates.find((c) => c.group === wanted)
      if (match) rel = match.rel
    }
    if (!rel) {
      const lossless = candidates.find((c) => c.group === 'lossless')
      const primary = candidates.find((c) => c.group === 'primary')
      rel = (lossless || primary || candidates[0]).rel
    }
    absPaths.push(path.join(musicRoot, rel))
  }
  return absPaths
}

internalRouter.get('/search', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim()
    if (!term) return res.json({ songs: [] })
    const settings = await readSettings()
    const storefront = String(req.query.storefront || settings.storefront || 'us')
    const limit = Math.min(Number(req.query.limit || 10), 25)
    const reqLang = req.query.language || req.query.l
    const language = reqLang ? toAppleLanguage(reqLang) : (settings.language || 'en-US')

    // Single paced search query directly to Apple. Avoid extra per-result queries
    // to keep API usage to the absolute minimum and protect against rate-limits.
    const data = await spacedSearch(() =>
      searchCatalog({
        storefront,
        term,
        types: 'songs',
        limit,
        offset: 0,
        language,
      }),
    )
    const songs = (data?.results?.songs?.data || []).map(mapSong)
    res.json({ songs, storefront })
  } catch (err) {
    // Surface Apple's real status (429 in particular) instead of flattening
    // everything to 502, so a caller like importer/lib/backendClient.mjs can
    // tell "rate limited, retry me" apart from "something's actually broken".
    const upstreamStatus = Number(String(err.message || '').match(/Apple API (\d+)/)?.[1])
    const status = upstreamStatus === 429 ? 429 : 502
    res.status(status).json({ error: err.message })
  }
})

internalRouter.post('/download/song', async (req, res) => {
  try {
    const { songId, albumId, storefront, quality } = req.body || {}
    if (!songId) return res.status(400).json({ error: 'songId required' })
    const settings = await readSettings()
    const effectiveStorefront = String(storefront || settings.storefront || 'us')
    const effectiveQuality = quality || settings.downloadQuality || 'flac'
    const jobId = await enqueueSong(songId, albumId || null, {
      storefront: effectiveStorefront,
      quality: effectiveQuality,
    })
    res.json({ ok: true, jobId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

internalRouter.get('/download/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

internalRouter.post('/playlist/m3u-export', async (req, res) => {
  try {
    const { title, tracks } = req.body || {}
    if (!title) return res.status(400).json({ error: 'title required' })
    if (!Array.isArray(tracks)) return res.status(400).json({ error: 'tracks required' })
    const trackIndex = tracks
      .filter((t) => t && t.name)
      .map((t) => ({ name: String(t.name), artistName: String(t.artistName || '') }))
    const absPaths = await resolveTracksToLocalPaths(trackIndex)
    if (absPaths.length === 0) {
      return res.json({ ok: true, written: false, trackCount: 0 })
    }
    const filePath = await writePlaylistM3U({
      playlistName: title,
      tracks: absPaths,
      reuseArtwork: true,
    })
    res.json({ ok: true, written: true, trackCount: absPaths.length, filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

internalRouter.get('/health', async (_req, res) => {
  try {
    const wrapper = await probeWrapperPorts({ timeoutMs: 1500 })
    let appleTokenOk = false
    let appleTokenError = null
    try {
      const token = await getBearerToken()
      appleTokenOk = Boolean(token)
    } catch (err) {
      appleTokenError = err.message
    }
    const jobs = listJobs()
    const running = jobs.filter((j) => j.status === 'running').length
    const queued = jobs.filter((j) => j.status === 'queued').length

    const failedPorts = (wrapper.failedPorts || []).map((p) => {
      let friendlyError = p.error
      if (p.error === 'ENOTFOUND') friendlyError = 'wrapper container is not running (ENOTFOUND)'
      else if (p.error === 'ECONNREFUSED') friendlyError = 'wrapper starting or no credentials (ECONNREFUSED)'
      else if (p.error === 'timeout') friendlyError = 'connection timed out'
      return { ...p, friendlyError }
    })

    res.json({
      ok: Boolean(wrapper.ok && appleTokenOk),
      wrapper: {
        ok: Boolean(wrapper.ok),
        host: wrapper.host,
        failedPorts,
      },
      appleToken: {
        ok: appleTokenOk,
        error: appleTokenError,
      },
      queue: {
        running,
        queued,
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
