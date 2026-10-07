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
  { matches: matchesSpotify, parse: parseSpotifyPlaylist },
  { matches: matchesNetease, parse: parseNeteasePlaylist },
  { matches: matchesYoutube, parse: parseYoutubePlaylist },
  { matches: matchesQishui, parse: parseQishuiPlaylist },
  { matches: matchesKkbox, parse: parseKkboxPlaylist },
  { matches: matchesGenericSite, parse: parseGenericSite },
]

export { URL_PARSERS }

// { text, urls } -> { title, tracks: [{ raw, title, artists }], warnings: string[] }
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
        return { url, result: await parser.parse(url) }
      })
    )

    for (let i = 0; i < results.length; i++) {
      const res = results[i]
      const url = allUrls[i]
      if (res.status === 'fulfilled') {
        const { result } = res.value
        if (!playlistTitle && result.title) playlistTitle = result.title
        if (Array.isArray(result.tracks)) allTracks.push(...result.tracks)
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
    allTracks.push(...plainTracks)
  }

  return {
    title: playlistTitle,
    tracks: allTracks,
    warnings: allWarnings,
  }
}
