import { decodeHtmlEntities } from '../../lib/htmlEntities.mjs'
import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)silverbox\.com\.tw$/i

export function matchesSilverbox(url) {
  try {
    const u = new URL(url)
    return HOST_RE.test(u.hostname) && /^\/rank\//i.test(u.pathname)
  } catch {
    return false
  }
}

export function parseSilverboxHtml(html) {
  const tracks = []
  const rowRe = /<li class="songItem">([\s\S]*?)<\/li>/g
  let match
  while ((match = rowRe.exec(html))) {
    const block = match[1]
    const title = block.match(/<div class="songTitle">([\s\S]*?)<\/div>/)?.[1]?.trim()
    const singer = block.match(/<div class="singer">([\s\S]*?)<\/div>/)?.[1]?.trim()
    if (!title) continue
    tracks.push({
      raw: `${title} - ${singer || ''}`,
      title: decodeHtmlEntities(title),
      artists: (singer || '')
        .split(',')
        .map((a) => decodeHtmlEntities(a.trim()))
        .filter(Boolean),
    })
  }
  return tracks
}

// 銀櫃KTV rank pages are fully server-rendered — every `<li class="songItem">`
// row is already in the initial HTML, no AJAX call needed.
export async function parseSilverbox(url) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgentFor('SILVERBOX_USER_AGENT') } })
  if (!res.ok) {
    const err = new Error(`Silverbox page fetch failed (${res.status})`)
    err.status = 502
    throw err
  }
  const html = await res.text()
  const tracks = parseSilverboxHtml(html)
  if (tracks.length === 0) {
    const err = new Error('could not parse the Silverbox rank page (layout may have changed)')
    err.status = 502
    throw err
  }
  return { title: null, tracks }
}
