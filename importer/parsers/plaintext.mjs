// "Title - Artist[, Artist2, ...]" per line, e.g.:
//   七里香 - 周杰倫
//   甜甜的-周杰倫
//   千里之外 - 周杰倫, 費玉清
// Tolerates en/em-dash variants, spaces or no spaces around hyphens, and both
// Western and Chinese commas between multiple artists.
// A line with no dash is kept as a title-only/search-term entry (still searchable,
// and disambiguated or presented for preview).
export function parsePlainText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line) => {
    const dashMatch = line.match(/^(.+?)\s*[-–—]\s*(.+)$/)
    if (dashMatch) {
      const title = dashMatch[1].trim()
      const artistsRaw = dashMatch[2].trim()
      const artists = artistsRaw
        .split(/[,，、]/)
        .map((a) => a.trim())
        .filter(Boolean)
      return { raw: line, title, artists }
    }
    return { raw: line, title: line, artists: [] }
  })
}
