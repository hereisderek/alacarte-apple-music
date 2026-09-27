import express from 'express'

import { searchCatalog } from '../lib/appleApi.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { enqueueSong, getJob } from '../lib/queue.mjs'
import { resolveTracksToLocalPaths, writePlaylistM3U } from '../lib/playlistExport.mjs'
import { createSpacer } from '../lib/requestSpacer.mjs'

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
    albumId: m ? m[1] : null,
    albumName: x.attributes?.albumName,
    durationMs: x.attributes?.durationInMillis,
    artworkTemplate: x.attributes?.artwork?.url || null,
    isrc: x.attributes?.isrc || null,
  }
}

internalRouter.get('/search', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim()
    if (!term) return res.json({ songs: [] })
    const settings = await readSettings()
    const storefront = String(req.query.storefront || settings.storefront || 'us')
    const limit = Math.min(Number(req.query.limit || 10), 25)
    const data = await spacedSearch(() =>
      searchCatalog({
        storefront,
        term,
        types: 'songs',
        limit,
        offset: 0,
        language: settings.language || 'en-US',
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
    const job = await enqueueSong({ songId, albumId: albumId || null, storefront, quality })
    res.status(202).json({ job })
  } catch (err) {
    if (err?.statusCode === 409 || err?.code === 'ALREADY_IN_LIBRARY') {
      return res.status(409).json({ error: err.message || 'Already in library' })
    }
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
