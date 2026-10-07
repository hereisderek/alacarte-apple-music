import express from 'express'

import { searchCatalog } from '../lib/appleApi.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { enqueueSong, getJob, listJobs } from '../lib/queue.mjs'
import { resolveTracksToLocalPaths, writePlaylistM3U } from '../lib/playlistExport.mjs'
import { createSpacer } from '../lib/requestSpacer.mjs'
import { toAppleLanguage } from '../lib/metadataLanguage.mjs'
import { resolveLocalizedArtistName } from '../lib/localizedArtist.mjs'
import { probeWrapperPorts } from '../lib/wrapperHealth.mjs'
import { getBearerToken } from '../lib/appleToken.mjs'

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

internalRouter.get('/search', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim()
    if (!term) return res.json({ songs: [] })
    const settings = await readSettings()
    const storefront = String(req.query.storefront || settings.storefront || 'us')
    const limit = Math.min(Number(req.query.limit || 10), 25)
    const reqLang = req.query.language || req.query.l
    const language = reqLang ? toAppleLanguage(reqLang) : (settings.language || 'en-US')
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

    const nameReplacements = new Map()
    const artistsToResolve = new Map()
    for (const s of songs) {
      if (s.artistId && s.artistName && !artistsToResolve.has(s.artistId)) {
        artistsToResolve.set(s.artistId, s.artistName)
      }
    }
    if (artistsToResolve.size > 0) {
      await Promise.all(
        Array.from(artistsToResolve.entries()).map(async ([artistId, artistName]) => {
          const localized = await resolveLocalizedArtistName({
            artistId,
            artistName,
            language,
          })
          if (localized && localized !== artistName) {
            nameReplacements.set(artistName, localized)
            nameReplacements.set(artistId, localized)
          }
        }),
      )
      if (nameReplacements.size > 0) {
        for (const s of songs) {
          if (s.artistId && nameReplacements.has(s.artistId)) {
            s.artistName = nameReplacements.get(s.artistId)
          } else if (nameReplacements.has(s.artistName)) {
            s.artistName = nameReplacements.get(s.artistName)
          }
        }
      }
    }

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

