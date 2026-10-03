import express from 'express'

import { onSessionVersionBumped } from '../lib/authStore.mjs'
import { onEvent } from '../lib/eventBus.mjs'

export const eventsRouter = express.Router()

eventsRouter.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  // A client that stops reading would otherwise buffer every event in
  // memory. Events are dropped until it catches up, and then the stream is
  // closed so the browser reconnects and reloads the state it missed.
  let blocked = false
  let dropped = false
  const send = (chunk) => {
    if (blocked) {
      dropped = true
      return
    }
    if (!res.write(chunk)) {
      blocked = true
      res.once('drain', () => {
        if (dropped) cleanup()
        else blocked = false
      })
    }
  }

  send(`: connected\n\n`)
  const heartbeat = setInterval(() => {
    send(`: hb\n\n`)
  }, 20_000)

  const off = onEvent((ev) => {
    try {
      send(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    } catch {}
  })

  // The stream was authorized when it opened; end it when that session is
  // revoked (password change, sign out on all devices).
  const sessionSv = req.session?.sv
  const offRevoke = onSessionVersionBumped((nextSv) => {
    if (Number.isInteger(sessionSv) && sessionSv < nextSv) cleanup()
  })

  let closed = false
  function cleanup() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    off()
    offRevoke()
    try {
      res.end()
    } catch {}
  }
  req.on('close', cleanup)
})
