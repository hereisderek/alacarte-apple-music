import express from 'express'

import { parseInput } from '../parsers/index.mjs'
import {
  createImportSession,
  getSession,
  publicSession,
  selectCandidate,
} from '../lib/importSession.mjs'
import { onEvent } from '../lib/eventBus.mjs'
import { getBackendHealth, searchSongs } from '../lib/backendClient.mjs'
import { pingSubsonic, searchSubsonicSongs } from '../lib/subsonicClient.mjs'
import { getInternalConfig } from '../lib/configStore.mjs'
import { getGlobalQueueStatus } from '../lib/importSession.mjs'

export const importRouter = express.Router()

importRouter.get('/status', async (_req, res) => {
  const { mode } = getInternalConfig()
  const queueStatus = getGlobalQueueStatus()

  if (mode === 'subsonic') {
    const ping = await pingSubsonic()
    return res.json({
      mode: 'subsonic',
      connected: ping.connected,
      ok: ping.ok,
      error: ping.error || null,
      subsonic: {
        ok: ping.ok,
        version: ping.version || '',
        serverType: ping.serverType || '',
        serverVersion: ping.serverVersion || '',
        openSubsonic: ping.openSubsonic || false,
      },
      queue: {
        running: queueStatus.active,
        queued: queueStatus.waiting,
        activeSong: queueStatus.activeSong,
      },
    })
  }

  const health = await getBackendHealth()
  res.json({
    mode: 'alacarte',
    ...health,
    queue: {
      running: queueStatus.active || health.queue?.running || 0,
      queued: queueStatus.waiting || health.queue?.queued || 0,
      activeSong: queueStatus.activeSong,
    },
  })
})

importRouter.post('/', async (req, res) => {
  try {
    const { text, urls, title, language } = req.body || {}
    const parsed = await parseInput({ text, urls })
    if (!parsed.tracks.length) {
      return res.status(400).json({ error: 'no tracks found in that input' })
    }
    const session = await createImportSession({
      title: title || parsed.title || 'Imported playlist',
      tracks: parsed.tracks,
      warnings: parsed.warnings,
      sources: parsed.sources,
      language: language ? String(language) : undefined,
    })
    res.status(202).json({ session: publicSession(session) })
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message })
  }
})

// Manual re-search for one line, used by the review UI's "search instead" box.
importRouter.get('/manual-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    const language = req.query.language ? String(req.query.language) : undefined
    if (!q) return res.json({ songs: [] })
    const { mode } = getInternalConfig()
    let songs = []
    if (mode === 'subsonic') {
      songs = await searchSubsonicSongs({ query: q, limit: 10 })
    } else {
      songs = await searchSongs({ q, limit: 10, language })
    }
    res.json({ songs })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

importRouter.get('/:id', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  res.json({ session: publicSession(session) })
})

importRouter.get('/:id/events', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).end()

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`data: ${JSON.stringify(publicSession(session))}\n\n`)

  const off = onEvent((evt) => {
    if (evt.sessionId !== req.params.id) return
    res.write(`data: ${JSON.stringify(evt.data)}\n\n`)
  })
  req.on('close', off)
})

importRouter.post('/:id/select', async (req, res) => {
  try {
    const { itemIndex, songId, albumId, name, artistName, details } = req.body || {}
    if (typeof itemIndex !== 'number') {
      return res.status(400).json({ error: 'itemIndex required' })
    }
    if (!songId) return res.status(400).json({ error: 'songId required' })
    const session = await selectCandidate(req.params.id, itemIndex, {
      // the candidate's other details (album, duration, bit rate, ...) are optional
      ...(details && typeof details === 'object' ? details : {}),
      id: songId,
      albumId: albumId || null,
      name,
      artistName,
    })
    res.json({ session: publicSession(session) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})
