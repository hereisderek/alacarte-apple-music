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
  const uniqueById = (list) => {
    const seen = new Set()
    return list.filter((x) => !seen.has(x.id) && seen.add(x.id))
  }
  const [latest, top] = ['latest-releases', 'top-releases'].map((name) =>
    uniqueById((item.views?.[name]?.data || []).filter((x) => x.attributes)).map((x) =>
      albumFromNormalized(normalizeAlbum(x)),
    ),
  )
  const filter = (albums) => filterAlbumsByRating(albums, explicitFilter || 'explicit')
  return {
    label: header(item, item.attributes?.description?.standard),
    latestReleases: filter(latest),
    topReleases: filter(top),
    // both views in one list with clean and explicit versions settled across
    // them, so download multiple offers each album once
    albums: filter(uniqueById([...latest, ...top])),
  }
}
