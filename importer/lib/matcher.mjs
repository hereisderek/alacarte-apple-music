// Turns Apple Music catalog search candidates into an auto-pick / not-found
// verdict for one parsed line.
//
// When artist info is provided (e.g. from playlist sources or "Title - Artist"
// plain text), the top candidate is auto-picked.
// When an arbitrary search term without singer info is given (e.g. "时光机"),
// auto-picking is withheld so the user can preview candidates and choose.
function queryMatchesCandidate(query, candidate) {
  if (!query || !candidate) return false
  const qLower = query.toLowerCase().trim()

  // 1. Direct or partial artist name match
  if (candidate.artistName) {
    const aLower = candidate.artistName.toLowerCase().trim()
    if (qLower.includes(aLower)) return true

    // Check Han character overlap for CJK names (e.g. 周杰倫 vs 周杰伦)
    const artistChars = [...candidate.artistName].filter((c) => /\p{Script=Han}/u.test(c))
    if (artistChars.length >= 2) {
      const matched = artistChars.filter((c) => query.includes(c))
      if (matched.length / artistChars.length >= 0.5) return true
    }
  }

  // 2. Direct album name match
  if (candidate.albumName) {
    const albLower = candidate.albumName.toLowerCase().trim()
    if (albLower.length >= 2 && qLower.includes(albLower)) return true
  }

  return false
}

export function pickBestMatch(candidates, { query, parsedArtists } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return { status: 'notfound', candidates: [] }

  const hasExplicitArtist = Array.isArray(parsedArtists) && parsedArtists.length > 0
  if (hasExplicitArtist) {
    return { status: 'matched', chosen: list[0], candidates: list.slice(0, 5) }
  }

  // If no explicit artist was parsed (e.g. plain text with no dash),
  // check if the search term contains singer/album info matching candidate[0].
  if (query) {
    const first = list[0]
    const qClean = query.trim().toLowerCase()
    const nameClean = (first.name || '').trim().toLowerCase()

    // If query is strictly the title alone with no singer info, require user preview
    if (qClean === nameClean || !queryMatchesCandidate(query, first)) {
      return { status: 'notfound', chosen: null, candidates: list.slice(0, 5) }
    }
  }

  return { status: 'matched', chosen: list[0], candidates: list.slice(0, 5) }
}
