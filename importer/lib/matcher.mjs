// Turns Apple Music / Subsonic search candidates into an auto-pick / not-found
// verdict for one parsed line.

function cjkSimilarity(s1, s2) {
  if (!s1 || !s2) return 0
  const c1 = [...s1.toLowerCase()].filter((c) => /\p{Script=Han}/u.test(c))
  const c2 = [...s2.toLowerCase()].filter((c) => /\p{Script=Han}/u.test(c))
  if (c1.length === 0 || c2.length === 0) return 0
  let shared = 0
  const set2 = new Set(c2)
  for (const char of c1) {
    if (set2.has(char)) shared++
  }
  return shared / Math.max(c1.length, c2.length)
}

function stringMatchScore(target, candidateStr) {
  if (!target || !candidateStr) return 0
  const t = target.toLowerCase().trim()
  const c = candidateStr.toLowerCase().trim()
  if (t === c) return 10
  if (c.includes(t) || t.includes(c)) return 8
  const cjkSim = cjkSimilarity(t, c)
  if (cjkSim >= 0.4) return Math.round(cjkSim * 10)
  return 0
}

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

export function pickBestMatch(candidates, { query, title, parsedArtists = [] } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return { status: 'notfound', candidates: [] }

  const hasExplicitArtist = Array.isArray(parsedArtists) && parsedArtists.length > 0

  // If no title, parsedArtists, or query was provided, default to first candidate
  if (!query && !title && (!parsedArtists || parsedArtists.length === 0)) {
    return { status: 'matched', chosen: list[0], candidates: list.slice(0, 5) }
  }

  // Score all candidates
  let bestCandidate = list[0]
  let bestScore = 0
  let bestIsInverted = false

  for (const cand of list) {
    const candName = cand.name || ''
    const candArtist = cand.artistName || ''

    let tScore = title ? stringMatchScore(title, candName) : 0
    let aScore = 0
    for (const a of parsedArtists) {
      aScore = Math.max(aScore, stringMatchScore(a, candArtist))
    }

    // Check inverted match (title is artistName, artist is song name)
    let invTScore = title ? stringMatchScore(title, candArtist) : 0
    let invAScore = 0
    for (const a of parsedArtists) {
      invAScore = Math.max(invAScore, stringMatchScore(a, candName))
    }

    const standardTotal = tScore + aScore
    const invertedTotal = invTScore + invAScore

    const currentScore = Math.max(standardTotal, invertedTotal)
    const isInverted = invertedTotal > standardTotal && invertedTotal >= 8

    if (currentScore > bestScore) {
      bestScore = currentScore
      bestCandidate = cand
      bestIsInverted = isInverted
    }
  }

  // If candidate has zero relevance to the requested song/artist:
  if (hasExplicitArtist && title && bestScore === 0) {
    if (!queryMatchesCandidate(query, list[0])) {
      return { status: 'notfound', chosen: null, candidates: list.slice(0, 5) }
    }
  }

  // If no explicit artist was parsed (e.g. single title with no dash):
  if (!hasExplicitArtist) {
    if (query) {
      const first = list[0]
      const qClean = query.trim().toLowerCase()
      const nameClean = (first.name || '').trim().toLowerCase()
      if (qClean === nameClean || !queryMatchesCandidate(query, first)) {
        return { status: 'notfound', chosen: null, candidates: list.slice(0, 5) }
      }
    }
  }

  return {
    status: 'matched',
    chosen: bestCandidate,
    isInverted: bestIsInverted,
    candidates: list.slice(0, 5),
  }
}
