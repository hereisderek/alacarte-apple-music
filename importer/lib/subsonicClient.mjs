import crypto from 'node:crypto'
import { getInternalConfig } from './configStore.mjs'

function getCredentials(override = {}) {
  const cfg = getInternalConfig().subsonic
  const url = (override.url && override.url.trim() ? override.url.trim() : (cfg.url || 'http://octo-fiesta:8080')).replace(/\/+$/, '')
  const username = (override.username !== undefined && override.username.trim() !== '')
    ? override.username.trim()
    : (cfg.username || '')
  const password = (override.password !== undefined && override.password !== '')
    ? override.password
    : (cfg.password || '')
  const downloadEndpoint = (override.downloadEndpoint && override.downloadEndpoint.trim()
    ? override.downloadEndpoint.trim()
    : (cfg.downloadEndpoint || 'rest/stream.view')
  ).replace(/^\/+/, '')
  return { url, username, password, downloadEndpoint }
}

function buildAuthParams(username, password) {
  const params = new URLSearchParams()
  params.set('u', username || '')
  params.set('v', '1.16.1')
  params.set('c', 'alacarte-importer')
  params.set('f', 'json')

  if (password) {
    const salt = crypto.randomBytes(6).toString('hex')
    const token = crypto.createHash('md5').update(password + salt).digest('hex')
    params.set('t', token)
    params.set('s', salt)
  }

  return params
}

export function buildSubsonicUrl(endpoint, extraParams = {}, override = {}) {
  const creds = getCredentials(override)
  const params = buildAuthParams(creds.username, creds.password)
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null) {
      if (Array.isArray(v)) {
        for (const item of v) params.append(k, String(item))
      } else {
        params.set(k, String(v))
      }
    }
  }
  const cleanEndpoint = endpoint.replace(/^\/+/, '')
  return `${creds.url}/${cleanEndpoint}?${params.toString()}`
}

export async function pingSubsonic(override = {}) {
  const creds = getCredentials(override)
  if (!creds.url) {
    return { connected: false, ok: false, error: 'Subsonic URL not configured' }
  }
  if (!creds.username || !creds.password) {
    return { connected: false, ok: false, error: 'Subsonic username and password are required' }
  }

  try {
    const targetUrl = buildSubsonicUrl('rest/ping.view', {}, override)
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) {
      return {
        connected: true,
        ok: false,
        error: `Subsonic ping returned HTTP ${res.status}`,
      }
    }
    const data = await res.json().catch(() => null)
    const sub = data?.['subsonic-response']
    if (!sub || sub.status !== 'ok') {
      const msg = sub?.error?.message || 'Invalid Subsonic response'
      return {
        connected: true,
        ok: false,
        error: msg,
      }
    }

    return {
      connected: true,
      ok: true,
      version: sub.version || '1.16.1',
      serverType: sub.type || 'subsonic',
      serverVersion: sub.serverVersion || '',
      openSubsonic: Boolean(sub.openSubsonic),
    }
  } catch (err) {
    return {
      connected: false,
      ok: false,
      error: err.message || 'Subsonic server unreachable',
    }
  }
}

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export async function searchSubsonicSongs({ query, limit = 5, ...override } = {}) {
  if (!query || !query.trim()) return []
  const creds = getCredentials(override)
  const targetUrl = buildSubsonicUrl('rest/search3.view', {
    query: query.trim(),
    songCount: limit,
  }, override)

  const res = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) {
    throw new Error(`Subsonic search failed (HTTP ${res.status})`)
  }

  const data = await res.json().catch(() => null)
  const sub = data?.['subsonic-response']
  if (!sub || sub.status !== 'ok') {
    throw new Error(sub?.error?.message || 'Subsonic search error')
  }

  const rawSongs = sub.searchResult3?.song || []
  return rawSongs.map((s) => ({
    id: s.id,
    name: s.title,
    artistName: s.artist || s.displayArtist || 'Unknown Artist',
    albumId: s.albumId || null,
    albumName: s.album || null,
    durationMs: typeof s.duration === 'number' ? s.duration * 1000 : null,
    // What the server knows about the file: bit rate (kbps), format, size, year, ...
    // (samplingRate/bitDepth/channelCount only come from OpenSubsonic servers).
    bitRate: numberOrNull(s.bitRate),
    suffix: s.suffix || null,
    contentType: s.contentType || null,
    sizeBytes: numberOrNull(s.size),
    year: numberOrNull(s.year),
    genre: s.genre || null,
    trackNumber: numberOrNull(s.track),
    discNumber: numberOrNull(s.discNumber),
    samplingRate: numberOrNull(s.samplingRate),
    bitDepth: numberOrNull(s.bitDepth),
    channelCount: numberOrNull(s.channelCount),
    isrc: (Array.isArray(s.isrc) ? s.isrc[0] : s.isrc) || null,
    artworkTemplate: s.coverArt
      ? `${creds.url}/rest/getCoverArt.view?id=${encodeURIComponent(s.coverArt)}`
      : null,
  }))
}

export async function downloadSubsonicSongStream(songId, { signal, override = {} } = {}) {
  if (!songId) throw new Error('Missing songId for download')
  const creds = getCredentials(override)
  const endpoint = creds.downloadEndpoint || 'rest/stream.view'

  const targetUrl = buildSubsonicUrl(endpoint, { id: songId }, override)
  const res = await fetch(targetUrl, {
    signal: signal || AbortSignal.timeout(300_000), // 5-minute timeout for streaming
  })

  if (!res.ok && res.status !== 206) {
    throw new Error(`Subsonic download HTTP ${res.status}: ${res.statusText}`)
  }

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const json = await res.json().catch(() => null)
    const err = json?.['subsonic-response']?.error
    if (err) {
      throw new Error(`Subsonic error ${err.code}: ${err.message}`)
    }
  }

  // Drain the audio stream to completion so octo-fiesta / provider fully downloads/caches
  let bytesDownloaded = 0
  if (res.body) {
    for await (const chunk of res.body) {
      bytesDownloaded += chunk.length
    }
  }

  return {
    ok: true,
    bytesDownloaded,
  }
}
