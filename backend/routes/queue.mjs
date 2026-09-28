import express from 'express'

import {
  listJobs,
  listHistory,
  getQueueState,
  setQueuePaused,
  reorderQueue,
} from '../lib/queue.mjs'

export const queueRouter = express.Router()

queueRouter.get('/', (_req, res) => {
  res.json({ jobs: listJobs(), ...getQueueState() })
})

queueRouter.get('/history', (req, res) => {
  res.json({ jobs: listHistory(req.query?.limit) })
})

queueRouter.put('/order', (req, res) => {
  if (!Array.isArray(req.body?.ids)) return res.status(400).json({ error: 'ids must be an array' })
  res.json({ order: reorderQueue(req.body.ids) })
})

queueRouter.post('/pause', (_req, res) => {
  res.json(setQueuePaused(true))
})

queueRouter.post('/resume', (_req, res) => {
  res.json(setQueuePaused(false))
})
