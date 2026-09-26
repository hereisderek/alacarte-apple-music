// Language preferences for the UI and for metadata-driven naming (song /
// album / artist names used for folders, filenames, and tags).
//
// Deliberately a small, curated set rather than exhaustive i18n coverage —
// see README's "Language support" section for what's covered today and what
// a follow-up pass would add.
export const LANGUAGE_CATALOG = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
]

export const ACCEPTED_LANGUAGE_VALUES = new Set(LANGUAGE_CATALOG.map((l) => l.code))

// UI language adds 'system' — "follow the browser's language, falling back
// to English if it can't be detected or isn't one of the languages above".
export const UI_LANGUAGE_VALUES = new Set(['system', ...ACCEPTED_LANGUAGE_VALUES])

export const NAMING_LANGUAGE_MODE_VALUES = new Set([
  'display', // my display language, falling back to original if untranslated
  'original-if-accepted', // original language if it's in my accepted list, else display
  'dual', // display language, with "(original)" appended when they differ
])

export const DEFAULT_NAMING_LANGUAGE_MODE = 'display'
export const MAX_ACCEPTED_LANGUAGES = 10

// The Apple catalog language tag Apple Music itself would show "at home" for
// a storefront — used as a stand-in for "the original-language name" when we
// fetch a second, home-locale copy of an album/song/playlist. A small,
// curated map covering the storefronts already offered in Settings; a
// storefront left out simply skips original-language lookups and naming
// falls back to display-language behavior (today's behavior, unchanged).
export const STOREFRONT_HOME_LANGUAGE = {
  us: 'en-US',
  gb: 'en-GB',
  ca: 'en-US',
  au: 'en-US',
  ie: 'en-GB',
  nz: 'en-US',
  sg: 'en-US',
  in: 'en-US',
  za: 'en-US',
  jp: 'ja-JP',
  kr: 'ko-KR',
  tw: 'zh-Hant-TW',
  hk: 'zh-Hant-HK',
  fr: 'fr-FR',
  be: 'fr-FR',
  ch: 'fr-FR',
  es: 'es-ES',
  mx: 'es-MX',
  ar: 'es-ES',
  cl: 'es-ES',
  co: 'es-ES',
  de: 'de-DE',
  at: 'de-DE',
  it: 'it-IT',
}

export function homeLanguageForStorefront(storefront) {
  return STOREFRONT_HOME_LANGUAGE[String(storefront || '').toLowerCase()] || null
}

// Cheap, dependency-free script sniff — enough to tell CJK/Hangul originals
// apart from everything else, which covers the stated use case (Chinese
// original names surviving alongside an English display language). It can't
// distinguish Latin-script languages from one another (en vs es vs fr); a
// real language-detection library would be needed for that — follow-up work,
// see README.
const KANA_RE = /[぀-ヿ]/
const HAN_RE = /[一-鿿㐀-䶿]/
const HANGUL_RE = /[가-힣]/

export function detectScript(text) {
  if (!text) return null
  const s = String(text)
  if (KANA_RE.test(s)) return 'ja'
  if (HANGUL_RE.test(s)) return 'ko'
  if (HAN_RE.test(s)) return 'zh'
  return null
}

/**
 * Resolve the final metadata name (song / album / artist) for the user's
 * naming-language preference.
 *
 * `displayName` is the name Apple returned for the user's configured
 * catalog `language` setting; `originalName` is the name Apple returned for
 * the storefront's home locale. When they're equal (Apple had nothing
 * distinct to offer — the common case for most Western-market content),
 * every mode collapses to `displayName`, so this is a no-op for the
 * majority of downloads.
 */
export function resolveMetadataName({
  mode,
  displayName,
  originalName,
  acceptedLanguages = [],
}) {
  const display = displayName || originalName || ''
  const original = originalName || display
  if (!original || !display || original === display) return display

  if (mode === 'original-if-accepted') {
    const script = detectScript(original)
    if (script && acceptedLanguages.includes(script)) return original
    return display
  }
  if (mode === 'dual') {
    return `${display} (${original})`
  }
  return display
}
