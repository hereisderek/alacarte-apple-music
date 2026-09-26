import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from './locales/en.json'
import zh from './locales/zh.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import es from './locales/es.json'
import fr from './locales/fr.json'

// Small, curated set of UI languages — must match backend/lib/metadataLanguage.mjs's
// LANGUAGE_CATALOG. Chinese ships as Simplified only for now (see README's
// "Language support" section for the follow-up on Traditional Chinese).
export const SUPPORTED_LANGUAGES = ['en', 'zh', 'ja', 'ko', 'es', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const LANGUAGE_NATIVE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  zh: '简体中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja },
      ko: { translation: ko },
      es: { translation: es },
      fr: { translation: fr },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    nonExplicitSupportedLngs: true,
    detection: {
      // "Follow system default" reads navigator.language; an explicit
      // uiLanguage setting (applyUiLanguage below) always overrides it and
      // is what gets cached, so a saved choice survives across browsers too
      // (it lives in backend settings, not just localStorage).
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
  })

// The exact localStorage key i18next-browser-languagedetector's default
// 'localStorage' cache uses (see its lookupLocalStorage option, which
// defaults to this name). applyUiLanguage below has to know it explicitly
// so it can clear a stale explicit pick when the user switches back to
// "Follow system default" — see the comment there for why.
const DETECTOR_CACHE_KEY = 'i18nextLng'

/**
 * Apply the user's uiLanguage setting ('system' | one of SUPPORTED_LANGUAGES).
 * 'system' re-runs browser-language detection (falling back to English when
 * the browser's language isn't one of the translated ones or can't be
 * detected — i18next's fallbackLng handles that automatically).
 *
 * The detector's cache ('localStorage', checked before 'navigator' — see the
 * `detection.order` above) is exactly what makes an explicit pick sticky
 * across reloads. That means switching back to "system" has to clear it
 * first: otherwise `changeLanguage(undefined)` just re-reads the previous
 * explicit pick out of localStorage instead of ever reaching
 * navigator.language, and "Follow system default" silently stops following
 * the system.
 */
export function applyUiLanguage(uiLanguage: string | null | undefined) {
  if (!uiLanguage || uiLanguage === 'system') {
    try {
      window.localStorage.removeItem(DETECTOR_CACHE_KEY)
    } catch {
      // Private browsing / blocked storage — detection still runs below,
      // it just won't be cached for next time.
    }
    void i18n.changeLanguage(undefined)
    return
  }
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(uiLanguage)) {
    void i18n.changeLanguage(uiLanguage)
  }
}

export default i18n
