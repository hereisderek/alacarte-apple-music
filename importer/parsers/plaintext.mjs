// "Title - Artist[, Artist2, ...]" per line, e.g.:
//   七里香 - 周杰倫
//   千里之外 - 周杰倫, 費玉清
// Tolerates en/em-dash variants and both Western and Chinese commas between
// multiple artists. A line with no " - " separator is kept as a title-only
// entry (still searchable, just without an artist to disambiguate on).
export function parsePlainText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line) => {
    const parts = line.split(/\s+[-–—]\s+/)
    if (parts.length < 2) {
      return { raw: line, title: line, artists: [] }
    }
    const title = parts[0].trim()
    const artistsRaw = parts.slice(1).join(' - ').trim()
    const artists = artistsRaw
      .split(/[,，、]/)
      .map((a) => a.trim())
      .filter(Boolean)
    return { raw: line, title, artists }
  })
}
