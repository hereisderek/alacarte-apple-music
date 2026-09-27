import { parsePlainText } from './plaintext.mjs'
import { matchesSpotify, parseSpotifyPlaylist } from './spotify/index.mjs'
import { matchesQishui, parseQishuiPlaylist } from './qishui/index.mjs'
import { matchesKkbox, parseKkboxPlaylist } from './kkbox/index.mjs'
import { matchesGenericSite, parseGenericSite } from './generic-site/index.mjs'

// Each URL parser lives in its own folder so the platform a link belongs to
// is obvious just from the path — see importer/SUPPORTED_LINKS.md for the
// tracked list and how to add another one.
const URL_PARSERS = [
  { matches: matchesSpotify, parse: parseSpotifyPlaylist },
  { matches: matchesQishui, parse: parseQishuiPlaylist },
  { matches: matchesKkbox, parse: parseKkboxPlaylist },
  { matches: matchesGenericSite, parse: parseGenericSite },
]

function extractUrls(text) {
  return String(text || '').match(/https?:\/\/\S+/g) || []
}

// { text, urls } -> { title, tracks: [{ raw, title, artists }] }
// A link (explicit `urls[]`, or one found inline in `text`) always wins over
// treating the input as a plain-text list — mixing the two isn't supported.
export async function parseInput({ text, urls } = {}) {
  const explicitUrls = (Array.isArray(urls) ? urls : []).filter(Boolean)
  const inlineUrls = extractUrls(text)
  const allUrls = [...new Set([...explicitUrls, ...inlineUrls])]

  if (allUrls.length > 0) {
    let title = null
    const tracks = []
    for (const url of allUrls) {
      const parser = URL_PARSERS.find((p) => p.matches(url))
      if (!parser) {
        const err = new Error(`unsupported link: ${url}`)
        err.status = 400
        throw err
      }
      const result = await parser.parse(url)
      if (!title && result.title) title = result.title
      tracks.push(...result.tracks)
    }
    return { title, tracks }
  }

  return { title: null, tracks: parsePlainText(text) }
}
