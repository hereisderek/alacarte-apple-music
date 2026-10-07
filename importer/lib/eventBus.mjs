import { EventEmitter } from 'node:events'

// Mirrors the main backend's lib/eventBus.mjs pattern, keyed by import
// session id instead of a fixed event type so the SSE route can filter to
// one session's stream.
const bus = new EventEmitter()
bus.setMaxListeners(200)

export function emitEvent(sessionId, data) {
  bus.emit('event', { sessionId, data, ts: Date.now() })
}

export function onEvent(listener) {
  bus.on('event', listener)
  return () => bus.off('event', listener)
}
