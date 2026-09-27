import { decodeHtmlEntities } from '../../lib/htmlEntities.mjs'
import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)kkbox\.com$/i

export function matchesKkbox(url) {
  try {
    const u = new URL(url)
    return HOST_RE.test(u.hostname) && /\/playlist\//.test(u.pathname)
  } catch {
    return false
  }
}

export function parseKkboxHtml(html) {
  const titleMatch = html.match(/"@type":"MusicPlaylist"[\s\S]*?"name":"((?:[^"\\]|\\.)*)"/)
  const title = titleMatch ? JSON.parse(`"${titleMatch[1]}"`) : null

  const tracks = []
  const rowRe =
    /<div class="song" title="((?:[^"\\]|\\.)*)">[\s\S]*?<div class="artist-album">\s*<a[^>]*>([^<]+)<\/a>/g
  let match
  while ((match = rowRe.exec(html))) {
    const trackTitle = decodeHtmlEntities(match[1])
    const artist = decodeHtmlEntities(match[2])
    tracks.push({ raw: `${trackTitle} - ${artist}`, title: trackTitle, artists: [artist] })
  }
  return { title, tracks }
}

// Best-effort only: KKBOX fronts playlist pages with an AWS WAF bot
// challenge that a plain server-side fetch usually can't pass (no JS
// execution). This works when the challenge isn't triggered and fails with
// an actionable message otherwise. See importer/SUPPORTED_LINKS.md.
export async function parseKkboxPlaylist(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgentFor('KKBOX_USER_AGENT'),
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
  })
  if (res.headers.get('x-amzn-waf-action') || !res.ok) {
    const err = new Error(
      'KKBOX blocked this request (bot protection). Paste the track list as plain text instead.',
    )
    err.status = 502
    throw err
  }
  const html = await res.text()
  const { title, tracks } = parseKkboxHtml(html)
  if (tracks.length === 0) {
    const err = new Error('could not parse KKBOX playlist page (layout may have changed)')
    err.status = 502
    throw err
  }
  return { title, tracks }
}
