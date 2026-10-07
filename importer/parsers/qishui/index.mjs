import { extractAssignedJson } from '../../lib/extractInlineJson.mjs'
import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)qishui\.com$/i

export function matchesQishui(url) {
  try {
    const u = new URL(url)
    return HOST_RE.test(u.hostname) && /\/share\/playlist/.test(u.pathname)
  } catch {
    return false
  }
}

// The share page server-renders a `_ROUTER_DATA` blob with the playlist
// title and its first batch of tracks (~150-200 of a longer playlist are
// included; the rest need the app's paginated API, out of scope for now).
export async function parseQishuiPlaylist(url) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgentFor('QISHUI_USER_AGENT') } })
  if (!res.ok) {
    const err = new Error(`Qishui playlist fetch failed (${res.status})`)
    err.status = 502
    throw err
  }
  const html = await res.text()
  const data = extractAssignedJson(html, '_ROUTER_DATA')
  const page = data?.loaderData?.playlist_page
  const medias = Array.isArray(page?.medias) ? page.medias : []
  if (!page || medias.length === 0) {
    const err = new Error('could not parse Qishui playlist page (layout may have changed)')
    err.status = 502
    throw err
  }

  const tracks = medias
    .filter((m) => m.type === 'track' && m.entity?.track?.name)
    .map((m) => {
      const track = m.entity.track
      const artists = (track.artists || []).map((a) => a.name).filter(Boolean)
      return { raw: `${track.name} - ${artists.join(', ')}`, title: track.name, artists }
    })

  return { title: page.playlistInfo?.title || null, tracks }
}
