// Supports both "Title - Artist" and "Artist - Title" formats per line.
// Tolerates en/em-dash variants, underscores, and space delimiters with zero, one, or more spaces.
// Extracts soundtrack/drama subtitles, parenthetical tags, and batch frequency heuristics.
// Also filters non-song garbage lines (e.g. index.html, Thumbs.db, comment lines).

const NON_SONG_FILE_EXT = /\.(html?|php|asp|aspx|js|mjs|cjs|ts|tsx|css|json|xml|yaml|yml|txt|md|log|exe|dmg|iso|zip|rar|7z|tar|gz|m3u8?|cue|nfo)$/i
const AUDIO_FILE_EXT = /\.(mp3|flac|m4a|aac|wav|ogg|opus|alac|ape|wma)$/i
const TABLE_HEADER_LINE = /^(序号|歌名|歌曲|歌手|艺术家|专辑|时长|大小|track|title|artist|album|duration|time|size)$/i

// Common tags/remarks that attach to titles rather than artists
const TITLE_REMARK_PATTERN = /(?:《.+?电视剧.+?》|电视剧.+?片[头尾]曲|电影.+?主题曲|片[头尾]曲|主题曲|插曲|推广曲|OST|原声带|\bLive\b|现场|伴奏|纯享版|重制版|无损|\bRemix\b|\bDJ版\b|\bDemo\b|\bCover\b|原唱|翻唱)/i

export function cleanTitleRemarks(str) {
  if (!str) return ''
  return str
    .replace(/\s*[\(（](?:原唱|翻唱|cover)[:：\s‛'’"“”]*.*?[\)）]\s*/gi, ' ')
    .replace(/\s*《.*?电视剧.*?》\s*/g, ' ')
    .replace(/\s*电视剧.*?片[头尾]曲\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// An ISRC written on a line ("Title - Artist ISRC USAAA0000001", "[USAAA0000001]", ...)
// is taken out of the text and kept on the track, so it can be looked up directly.
const ISRC_IN_LINE = /[\[(]?\s*(?:ISRC[:\s]*)?\b([A-Z]{2}[A-Z0-9]{3}\d{7})\b\s*[\])]?/

function extractIsrc(line) {
  const m = ISRC_IN_LINE.exec(line)
  if (!m) return { text: line, isrc: null }
  return { text: line.replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim(), isrc: m[1] }
}

export function parsePlainText(text) {
  const rawLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  // 1. Filter out comments, non-song files, and table headers
  const lines = []
  for (const line of rawLines) {
    if (line.startsWith('#')) continue
    // Check if line looks like a web/data filename without music info (e.g. "index.html")
    if (NON_SONG_FILE_EXT.test(line) && !line.includes('-') && !line.includes('–') && !line.includes('—') && !line.includes('_')) {
      continue
    }
    if (TABLE_HEADER_LINE.test(line)) {
      continue
    }
    lines.push(line)
  }

  // 2. Pre-parse lines with hyphens, underscores, or spaces
  const parsedItems = []
  const leftCounts = {}
  const rightCounts = {}

  for (const rawLine of lines) {
    // Strip leading track numbers: "01. ", "1 - ", "[1] ", "1、"
    const { text: withoutIsrc, isrc } = extractIsrc(rawLine)
    const line = withoutIsrc
      .replace(/^\s*(?:\[\d+\]|\(\d+\)|\d+[\s.、_-]+)\s*/, '')
      .replace(AUDIO_FILE_EXT, '')
      .trim()

    // 1. Check explicit delimiters: -, –, —, _ with zero, one, or more spaces
    let parts = line.split(/\s*[-–—_]\s*/)
    if (parts.length >= 2) {
      let left = parts[0].trim()
      let right = parts[1].trim()

      if (parts.length >= 3) {
        if (TITLE_REMARK_PATTERN.test(parts[2])) {
          right = parts[1].trim()
        } else if (TITLE_REMARK_PATTERN.test(parts[0])) {
          left = parts[1].trim()
          right = parts[2].trim()
        } else {
          right = parts.slice(1).join(' - ').trim()
        }
      }

      parsedItems.push({ raw: rawLine, isrc, left, right, hasExplicitDelimiter: true })
      leftCounts[left] = (leftCounts[left] || 0) + 1
      rightCounts[right] = (rightCounts[right] || 0) + 1
      continue
    }

    // 2. Fallback: column tabs or double spaces
    const colParts = line.split(/\t+|\s{2,}/)
    if (colParts.length >= 2) {
      const left = colParts[0].trim()
      const right = colParts.slice(1).join(' ').trim()
      parsedItems.push({ raw: rawLine, isrc, left, right, hasExplicitDelimiter: false })
      leftCounts[left] = (leftCounts[left] || 0) + 1
      rightCounts[right] = (rightCounts[right] || 0) + 1
      continue
    }

    // 3. Fallback: single space when line has exactly 2 words, or Latin/Han boundary
    const twoWordMatch = line.match(/^(\S+)\s+(\S+)$/)
    const latinHanMatch = line.match(/^([A-Za-z0-9._'-]+)\s+([\p{Script=Han}].+)$/u)
    const hanLatinMatch = line.match(/^([\p{Script=Han}]+)\s+([A-Za-z0-9._'-].+)$/u)

    if (twoWordMatch) {
      const left = twoWordMatch[1].trim()
      const right = twoWordMatch[2].trim()
      parsedItems.push({ raw: rawLine, isrc, left, right, hasExplicitDelimiter: false })
      leftCounts[left] = (leftCounts[left] || 0) + 1
      rightCounts[right] = (rightCounts[right] || 0) + 1
      continue
    } else if (latinHanMatch) {
      const left = latinHanMatch[1].trim()
      const right = latinHanMatch[2].trim()
      parsedItems.push({ raw: rawLine, isrc, left, right, hasExplicitDelimiter: false })
      leftCounts[left] = (leftCounts[left] || 0) + 1
      rightCounts[right] = (rightCounts[right] || 0) + 1
      continue
    } else if (hanLatinMatch) {
      const left = hanLatinMatch[1].trim()
      const right = hanLatinMatch[2].trim()
      parsedItems.push({ raw: rawLine, isrc, left, right, hasExplicitDelimiter: false })
      leftCounts[left] = (leftCounts[left] || 0) + 1
      rightCounts[right] = (rightCounts[right] || 0) + 1
      continue
    }

    parsedItems.push({ raw: rawLine, isrc, single: line })
  }

  // 4. Batch direction analysis: count repeated strings on left vs right
  let leftDuplicates = 0
  for (const count of Object.values(leftCounts)) {
    if (count > 1) leftDuplicates += count - 1
  }
  let rightDuplicates = 0
  for (const count of Object.values(rightCounts)) {
    if (count > 1) rightDuplicates += count - 1
  }

  // If left side has duplicate artists (e.g. Beyond, By2, F.I.R.), batch is Artist - Title!
  // If right side has duplicate artists (e.g. 周杰倫, 周杰倫), batch is Title - Artist!
  const batchDefaultArtistFirst = leftDuplicates > rightDuplicates
  const batchDefaultTitleFirst = rightDuplicates > leftDuplicates

  // 5. Resolve each line
  return parsedItems.map((item) => {
    if (item.single !== undefined) {
      const track = {
        raw: item.raw,
        title: item.single,
        artists: [],
      }
      if (item.isrc) track.isrc = item.isrc
      Object.defineProperties(track, {
        partA: { value: item.single, enumerable: false, writable: true, configurable: true },
        partB: { value: null, enumerable: false, writable: true, configurable: true },
      })
      return track
    }

    const { left, right } = item

    // Determine direction for this line
    let isArtistFirst = false

    // Priority 1: Comma-separated or multiple artist indicators
    const leftHasMultipleArtists = /[,，、/&]\s*[\p{L}\p{N}]+/u.test(left)
    const rightHasMultipleArtists =
      /[,，、/&]\s*[\p{L}\p{N}]+/u.test(right) || /\b(feat\.|ft\.|with)\b/i.test(right)

    if (leftHasMultipleArtists && !rightHasMultipleArtists) {
      isArtistFirst = true
    } else if (rightHasMultipleArtists && !leftHasMultipleArtists) {
      isArtistFirst = false
    } else if (TITLE_REMARK_PATTERN.test(right) && !TITLE_REMARK_PATTERN.test(left)) {
      // Title remarks attach to right side -> right is Title, left is Artist
      isArtistFirst = true
    } else if (TITLE_REMARK_PATTERN.test(left) && !TITLE_REMARK_PATTERN.test(right)) {
      isArtistFirst = false
    } else if (batchDefaultArtistFirst) {
      isArtistFirst = true
    } else if (batchDefaultTitleFirst) {
      isArtistFirst = false
    } else if (/^[a-zA-Z0-9\s._'-]+$/.test(left) && /\p{Script=Han}/u.test(right)) {
      // Latin artist on left, Chinese title on right (e.g. Beyond - 光辉岁月, JS - 杀破狼, F4 - 流星雨)
      isArtistFirst = true
    } else {
      // Default fallback: Title - Artist
      isArtistFirst = false
    }

    const artistStr = isArtistFirst ? left : right
    const titleStr = isArtistFirst ? right : left

    const cleanedTitle = cleanTitleRemarks(titleStr) || titleStr
    const artists = artistStr
      .split(/[,，、/&]/)
      .map((a) => a.trim())
      .filter(Boolean)

    const track = {
      raw: item.raw,
      title: cleanedTitle,
      artists,
    }
    if (item.isrc) track.isrc = item.isrc
    Object.defineProperties(track, {
      partA: { value: left, enumerable: false, writable: true, configurable: true },
      partB: { value: right, enumerable: false, writable: true, configurable: true },
    })
    return track
  })
}
