import { getCurator, getRecordLabel } from './appleApi.mjs'
import { filterAlbumsByRating } from './contentRatingFilter.mjs'

function mapAlbum(item) {
  const a = item.attributes || {}
  return {
    id: item.id,
    type: item.type,
    name: a.name,
    artistId: null,
    artistName: a.artistName,
    releaseDate: a.releaseDate,
    year: a.releaseDate ? String(a.releaseDate).slice(0, 4) : null,
    trackCount: a.trackCount,
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    isSingle: a.isSingle,
    contentRating: a.contentRating,
    url: a.url,
    upc: a.upc || null,
  }
}

function mapPlaylist(item) {
  const a = item.attributes || {}
  return {
    id: item.id,
    type: item.type,
    name: a.name,
    curatorName: a.curatorName || 'Apple Music',
    trackCount: a.trackCount,
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    url: a.url,
    description: a.description?.standard || '',
  }
}

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
      .map(mapPlaylist),
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
      .map(mapAlbum)
    return filterAlbumsByRating(albums, explicitFilter || 'explicit')
  }
  return {
    label: header(item, item.attributes?.description?.standard),
    latestReleases: view('latest-releases'),
    topReleases: view('top-releases'),
  }
}
