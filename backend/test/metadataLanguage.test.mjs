import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectScript,
  resolveMetadataName,
  homeLanguageForStorefront,
  ACCEPTED_LANGUAGE_VALUES,
  UI_LANGUAGE_VALUES,
  NAMING_LANGUAGE_MODE_VALUES,
} from '../lib/metadataLanguage.mjs'

test('detectScript identifies CJK/Hangul scripts and falls back to null', () => {
  assert.equal(detectScript('泡沫'), 'zh')
  assert.equal(detectScript('さくら'), 'ja') // hiragana
  assert.equal(detectScript('サクラ'), 'ja') // katakana
  assert.equal(detectScript('안녕하세요'), 'ko')
  assert.equal(detectScript('Hello'), null)
  assert.equal(detectScript(''), null)
  assert.equal(detectScript(null), null)
})

test('detectScript prefers kana over han for Japanese titles containing kanji', () => {
  // Japanese titles routinely mix kanji (also valid Han) with kana; kana
  // presence should win so these aren't misclassified as Chinese.
  assert.equal(detectScript('東京タワー'), 'ja')
})

test('resolveMetadataName: display mode always returns the display name', () => {
  const name = resolveMetadataName({
    mode: 'display',
    displayName: 'Bubbles',
    originalName: '泡沫',
    acceptedLanguages: ['zh'],
  })
  assert.equal(name, 'Bubbles')
})

test('resolveMetadataName: identical names collapse to display in every mode', () => {
  for (const mode of ['display', 'original-if-accepted', 'dual']) {
    const name = resolveMetadataName({
      mode,
      displayName: 'Bohemian Rhapsody',
      originalName: 'Bohemian Rhapsody',
      acceptedLanguages: [],
    })
    assert.equal(name, 'Bohemian Rhapsody')
  }
})

test('resolveMetadataName: original-if-accepted keeps original only when its script is accepted', () => {
  const accepted = resolveMetadataName({
    mode: 'original-if-accepted',
    displayName: 'Bubbles',
    originalName: '泡沫',
    acceptedLanguages: ['zh', 'en'],
  })
  assert.equal(accepted, '泡沫')

  const notAccepted = resolveMetadataName({
    mode: 'original-if-accepted',
    displayName: 'Bubbles',
    originalName: '泡沫',
    acceptedLanguages: ['en', 'ja'],
  })
  assert.equal(notAccepted, 'Bubbles')
})

test('resolveMetadataName: dual mode appends the original name in parentheses', () => {
  const name = resolveMetadataName({
    mode: 'dual',
    displayName: 'Bubbles',
    originalName: '泡沫',
    acceptedLanguages: [],
  })
  assert.equal(name, 'Bubbles (泡沫)')
})

test('resolveMetadataName: original-if-accepted treats a detected zh script as matching either zh or zh-hant', () => {
  // detectScript can't tell Simplified from Traditional apart (see its
  // ponytail comment), so either accepted-language code should count.
  const acceptedViaHant = resolveMetadataName({
    mode: 'original-if-accepted',
    displayName: 'Bubbles',
    originalName: '泡沫',
    acceptedLanguages: ['zh-hant'],
  })
  assert.equal(acceptedViaHant, '泡沫')

  const acceptedViaHans = resolveMetadataName({
    mode: 'original-if-accepted',
    displayName: 'Bubbles',
    originalName: '泡沫',
    acceptedLanguages: ['zh'],
  })
  assert.equal(acceptedViaHans, '泡沫')
})

test('homeLanguageForStorefront covers common storefronts and is case-insensitive', () => {
  assert.equal(homeLanguageForStorefront('jp'), 'ja-JP')
  assert.equal(homeLanguageForStorefront('TW'), 'zh-Hant-TW')
  assert.equal(homeLanguageForStorefront('us'), 'en-US')
  assert.equal(homeLanguageForStorefront('zz'), null)
  assert.equal(homeLanguageForStorefront(undefined), null)
})

test('language value sets are consistent', () => {
  assert.ok(ACCEPTED_LANGUAGE_VALUES.has('zh'))
  assert.ok(ACCEPTED_LANGUAGE_VALUES.has('en'))
  assert.ok(UI_LANGUAGE_VALUES.has('system'))
  for (const code of ACCEPTED_LANGUAGE_VALUES) {
    assert.ok(UI_LANGUAGE_VALUES.has(code))
  }
  assert.ok(NAMING_LANGUAGE_MODE_VALUES.has('display'))
  assert.ok(NAMING_LANGUAGE_MODE_VALUES.has('original-if-accepted'))
  assert.ok(NAMING_LANGUAGE_MODE_VALUES.has('dual'))
})
