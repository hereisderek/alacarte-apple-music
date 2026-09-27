// Server-to-server client for the main alacarte backend's /api/internal/*
// surface (see backend/routes/internal.mjs). Never called from the browser —
// only from this service's own backend.
const BACKEND_URL = (process.env.BACKEND_URL || 'http://web:7373').replace(/\/+$/, '')
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || ''

const MAX_429_RETRIES = Math.max(0, Number(process.env.IMPORTER_MAX_429_RETRIES) || 6)
const MAX_BACKOFF_MS = Math.max(1_000, Number(process.env.IMPORTER_MAX_BACKOFF_MS) || 20_000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Apple's catalog search has a tight anonymous rate limit — a sequential
// batch import of a few dozen tracks trips it easily (confirmed against a
// real backend: a 24-track import produced twelve 429s before this retry
// existed, one even at a 300ms pace between searches). The backend doesn't
// forward Apple's own Retry-After, so this backs off blind but generously.
async function call(path, { method = 'GET', body } = {}, attempt = 0) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: {
      'X-Internal-Key': INTERNAL_API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 429 && attempt < MAX_429_RETRIES) {
    const retryAfterSec = Number(res.headers.get('retry-after'))
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)
    await sleep(delayMs)
    return call(path, { method, body }, attempt + 1)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error || `backend ${method} ${path} failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export async function searchSongs({ q, storefront, limit } = {}) {
  const params = new URLSearchParams({ q: q || '' })
  if (storefront) params.set('storefront', storefront)
  if (limit) params.set('limit', String(limit))
  const data = await call(`/api/internal/search?${params}`)
  return data?.songs || []
}

export async function enqueueSongDownload({ songId, albumId, storefront, quality } = {}) {
  const data = await call('/api/internal/download/song', {
    method: 'POST',
    body: { songId, albumId, storefront, quality },
  })
  return data?.job || null
}

export async function getDownloadJob(id) {
  try {
    const data = await call(`/api/internal/download/${encodeURIComponent(id)}`)
    return data?.job || null
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

export async function exportPlaylistM3u({ title, tracks }) {
  return call('/api/internal/playlist/m3u-export', {
    method: 'POST',
    body: { title, tracks },
  })
}
