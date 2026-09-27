import express from 'express'

import { parseInput } from '../parsers/index.mjs'
import {
  createImportSession,
  getSession,
  publicSession,
  selectCandidate,
} from '../lib/importSession.mjs'
import { onEvent } from '../lib/eventBus.mjs'
import { searchSongs } from '../lib/backendClient.mjs'

export const importRouter = express.Router()

importRouter.post('/', async (req, res) => {
  try {
    const { text, urls, title } = req.body || {}
    const parsed = await parseInput({ text, urls })
    if (!parsed.tracks.length) {
      return res.status(400).json({ error: 'no tracks found in that input' })
    }
    const session = await createImportSession({
      title: title || parsed.title || 'Imported playlist',
      tracks: parsed.tracks,
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
    if (!q) return res.json({ songs: [] })
    const songs = await searchSongs({ q, limit: 10 })
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
    const { itemIndex, songId, albumId, name, artistName } = req.body || {}
    if (typeof itemIndex !== 'number') {
      return res.status(400).json({ error: 'itemIndex required' })
    }
    if (!songId) return res.status(400).json({ error: 'songId required' })
    const session = await selectCandidate(req.params.id, itemIndex, {
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
