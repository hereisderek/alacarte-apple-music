const GROUP_BY_QUALITY = {
  flac: 'lossless',
  alac: 'lossless',
  atmos: 'atmos',
  aac: 'aac',
}

const LABEL_BY_GROUP = {
  lossless: 'ALAC',
  atmos: 'Atmos',
  aac: 'AAC',
}

const SUFFIX_RE = /\s*\((FLAC|ALAC|Atmos|AAC)\)$/i

export function groupOf(quality) {
  return GROUP_BY_QUALITY[quality] || 'lossless'
}

export function variantLabel(group, quality) {
  if (group === 'lossless') return quality === 'flac' ? 'FLAC' : 'ALAC'
  return LABEL_BY_GROUP[group] || null
}

export function applyVariantSuffix(dir, group, quality) {
  const label = variantLabel(group, quality)
  return label ? `${dir} (${label})` : dir
}

export function parseVariantSuffix(basename) {
  const m = SUFFIX_RE.exec(basename)
  if (!m) return null
  const label = m[1].toLowerCase()
  return label === 'atmos' ? 'atmos' : label === 'aac' ? 'aac' : 'lossless'
}
