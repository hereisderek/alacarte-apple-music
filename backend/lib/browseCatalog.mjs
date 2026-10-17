import {
  albumFromNormalized,
  getCurator,
  getRecordLabel,
  normalizeAlbum,
  normalizePlaylist,
  playlistFromNormalized,
} from './appleApi.mjs'
import { filterAlbumsByRating } from './contentRatingFilter.mjs'

function header(item, description) {
  const a = item.attributes || {}
  return {
    id: item.id,
    name: a.name,
    description: String(description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    url: a.url,
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
  }
}

export async function loadCurator({ id, storefront, language }) {
  const raw = await getCurator({ storefront, id, language })
  const item = raw?.data?.[0]
  if (!item) return null
  const notes = item.attributes?.editorialNotes
  return {
    curator: header(item, notes?.standard || notes?.short),
    playlists: (item.relationships?.playlists?.data || [])
      .filter((p) => p.attributes)
      .map((p) => playlistFromNormalized(normalizePlaylist(p))),
  }
}

export async function loadRecordLabel({ id, storefront, language, explicitFilter }) {
  const raw = await getRecordLabel({ storefront, id, language })
  const item = raw?.data?.[0]
  if (!item) return null
  const view = (name) => {
    const seen = new Set()
    const albums = (item.views?.[name]?.data || [])
      .filter((x) => x.attributes && !seen.has(x.id) && seen.add(x.id))
      .map((x) => albumFromNormalized(normalizeAlbum(x)))
    return filterAlbumsByRating(albums, explicitFilter || 'explicit')
  }
  return {
    label: header(item, item.attributes?.description?.standard),
    latestReleases: view('latest-releases'),
    topReleases: view('top-releases'),
  }
}
