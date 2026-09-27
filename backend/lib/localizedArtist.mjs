import { getArtistBasic } from './appleApi.mjs'
import { detectScript } from './metadataLanguage.mjs'

// In-memory cache for localized artist names: `${artistId}|${language}` -> string
const artistNameCache = new Map()

/**
 * Return candidate storefronts to look up localized artist metadata
 * based on target language.
 */
export function candidateStorefrontsForLanguage(language) {
  const l = String(language || '').toLowerCase()
  if (l.startsWith('zh-hant') || l === 'zh-tw' || l === 'zh-hk') {
    return ['tw', 'hk', 'us']
  }
  if (l.startsWith('zh')) {
    return ['us', 'tw', 'hk', 'cn']
  }
  if (l.startsWith('ja')) {
    return ['jp']
  }
  if (l.startsWith('ko')) {
    return ['kr']
  }
  return []
}

/**
 * Resolve an artist's localized name if their current name in the requested storefront
 * doesn't match the script of the target language (e.g. English "Mayday" on NZ storefront
 * when user requests Chinese "zh-Hans").
 */
export async function resolveLocalizedArtistName({ artistId, artistName, language }) {
  if (!artistId || !artistName || !language) return artistName

  const l = String(language || '').toLowerCase()
  const targetScript = l.startsWith('zh') ? 'zh' : l.startsWith('ja') ? 'ja' : l.startsWith('ko') ? 'ko' : null
  if (!targetScript) return artistName

  const currentScript = detectScript(artistName)
  if (currentScript === targetScript) {
    // Current name is already in the target script!
    return artistName
  }

  const cacheKey = `${artistId}|${language}`
  if (artistNameCache.has(cacheKey)) {
    return artistNameCache.get(cacheKey)
  }

  const storefronts = candidateStorefrontsForLanguage(language)
  for (const sf of storefronts) {
    try {
      const raw = await getArtistBasic({
        storefront: sf,
        id: artistId,
        language,
      })
      const localized = raw?.data?.[0]?.attributes?.name
      if (localized && detectScript(localized) === targetScript) {
        artistNameCache.set(cacheKey, localized)
        return localized
      }
    } catch {
      // Continue to next storefront candidate
    }
  }

  artistNameCache.set(cacheKey, artistName)
  return artistName
}

export function __clearLocalizedArtistCacheForTests() {
  artistNameCache.clear()
}
