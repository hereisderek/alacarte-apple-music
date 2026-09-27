import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)open\.spotify\.com$/i

export function matchesSpotify(url) {
  try {
    const u = new URL(url)
    return HOST_RE.test(u.hostname) && /\/playlist\//.test(u.pathname)
  } catch {
    return false
  }
}

export function extractNextData(html) {
  const marker = 'id="__NEXT_DATA__"'
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return null
  const tagEnd = html.indexOf('>', markerIdx)
  const scriptEnd = html.indexOf('</script>', tagEnd)
  if (tagEnd === -1 || scriptEnd === -1) return null
  try {
    return JSON.parse(html.slice(tagEnd + 1, scriptEnd))
  } catch {
    return null
  }
}

// Uses the no-auth embed page (open.spotify.com/embed/playlist/<id>) instead
// of the Web API, so no Spotify app/client credentials are required. Only
// returns the first batch of tracks the embed page ships (~50-100); very
// long playlists are truncated — a known limitation, not a bug.
export async function parseSpotifyPlaylist(url) {
  const u = new URL(url)
  const id = u.pathname.split('/playlist/')[1]?.split('/')[0]?.split('?')[0]
  if (!id) {
    const err = new Error('could not find a playlist id in this Spotify URL')
    err.status = 400
    throw err
  }

  const res = await fetch(`https://open.spotify.com/embed/playlist/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': userAgentFor('SPOTIFY_USER_AGENT') },
  })
  if (!res.ok) {
    const err = new Error(`Spotify playlist fetch failed (${res.status})`)
    err.status = 502
    throw err
  }
  const html = await res.text()
  const data = extractNextData(html)
  const entity = data?.props?.pageProps?.state?.data?.entity
  const trackList = Array.isArray(entity?.trackList) ? entity.trackList : []
  if (!entity || trackList.length === 0) {
    const err = new Error('could not parse Spotify playlist page (layout may have changed)')
    err.status = 502
    throw err
  }

  const tracks = trackList
    .filter((t) => t.entityType === 'track' && t.title)
    .map((t) => ({
      raw: `${t.title} - ${t.subtitle || ''}`,
      title: t.title,
      artists: String(t.subtitle || '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    }))

  return { title: entity.name || null, tracks }
}
