import { parsePlainText } from './plaintext.mjs'
import { matchesSpotify, parseSpotifyPlaylist } from './spotify/index.mjs'
import { matchesNetease, parseNeteasePlaylist } from './netease/index.mjs'
import { matchesYoutube, parseYoutubePlaylist } from './youtube/index.mjs'
import { matchesQishui, parseQishuiPlaylist } from './qishui/index.mjs'
import { matchesKkbox, parseKkboxPlaylist } from './kkbox/index.mjs'
import { matchesGenericSite, parseGenericSite } from './generic-site/index.mjs'

// Each URL parser lives in its own folder so the platform a link belongs to
// is obvious just from the path — see importer/SUPPORTED_LINKS.md for the
// tracked list and how to add another one.
const URL_PARSERS = [
  { name: 'spotify', label: 'Spotify', matches: matchesSpotify, parse: parseSpotifyPlaylist },
  { name: 'netease', label: 'NetEase Cloud Music', matches: matchesNetease, parse: parseNeteasePlaylist },
  { name: 'youtube', label: 'YouTube', matches: matchesYoutube, parse: parseYoutubePlaylist },
  { name: 'qishui', label: 'Qishui', matches: matchesQishui, parse: parseQishuiPlaylist },
  { name: 'kkbox', label: 'KKBOX', matches: matchesKkbox, parse: parseKkboxPlaylist },
  { name: 'generic-site', label: null, matches: matchesGenericSite, parse: parseGenericSite },
]

// Where a pasted link's tracks come from, for display: the platform and the link itself.
function sourceOf(parser, url) {
  let label = parser.label
  if (!label) {
    try {
      label = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      label = 'Website'
    }
  }
  return { kind: parser.name, label, url }
}

export { URL_PARSERS }

// { text, urls } -> { title, tracks: [{ raw, title, artists, source }], sources, warnings: string[] }
// `source` is { kind, label, url? } of the link (or plain text) a track came from; `sources`
// lists each one once with the number of tracks it gave.
// Supports arbitrary mixtures of multiple playlist URLs and plain-text song entries.
// URL parsing is executed concurrently for maximum efficiency; failure of any individual
// link does not abort parsing of the remaining links or plain text.
export async function parseInput({ text, urls } = {}) {
  const explicitUrls = (Array.isArray(urls) ? urls : []).filter(Boolean)

  const lines = String(text || '').split(/\r?\n/)
  const extractedUrls = []
  const textLines = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const matchedUrls = trimmed.match(/https?:\/\/\S+/g)
    if (matchedUrls) {
      extractedUrls.push(...matchedUrls)
      const rest = trimmed.replace(/https?:\/\/\S+/g, '').trim()
      if (rest) textLines.push(rest)
    } else {
      textLines.push(trimmed)
    }
  }

  const allUrls = [...new Set([...explicitUrls, ...extractedUrls])]
  const allTracks = []
  const allWarnings = []
  const sources = []
  let playlistTitle = null

  if (allUrls.length > 0) {
    const results = await Promise.allSettled(
      allUrls.map(async (url) => {
        const parser = URL_PARSERS.find((p) => p.matches(url))
        if (!parser) {
          const err = new Error(`unsupported link: ${url}`)
          err.status = 400
          throw err
        }
        return { url, parser, result: await parser.parse(url) }
      })
    )

    for (let i = 0; i < results.length; i++) {
      const res = results[i]
      const url = allUrls[i]
      if (res.status === 'fulfilled') {
        const { result, parser } = res.value
        if (!playlistTitle && result.title) playlistTitle = result.title
        if (Array.isArray(result.tracks)) {
          const source = sourceOf(parser, url)
          for (const track of result.tracks) track.source = source
          allTracks.push(...result.tracks)
          sources.push({ ...source, count: result.tracks.length })
        }
        if (result.warning) allWarnings.push(result.warning)
        if (Array.isArray(result.warnings)) allWarnings.push(...result.warnings)
      } else {
        const msg = res.reason?.message || 'unknown error'
        console.warn(`[import] failed to parse ${url}:`, msg)
        allWarnings.push(`Failed to parse link (${url}): ${msg}`)
      }
    }
  }

  if (textLines.length > 0) {
    const plainTracks = parsePlainText(textLines.join('\n'))
    const source = { kind: 'text', label: 'Pasted text' }
    for (const track of plainTracks) track.source = source
    allTracks.push(...plainTracks)
    sources.push({ ...source, count: plainTracks.length })
  }

  return {
    title: playlistTitle,
    tracks: allTracks,
    sources,
    warnings: allWarnings,
  }
}
