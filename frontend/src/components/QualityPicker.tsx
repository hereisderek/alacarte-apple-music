import { useTranslation } from 'react-i18next'

import type { QualityPreference } from '../api/client'
import { cx } from '../lib/cx'

export const QUALITY_OPTIONS: Array<{ value: QualityPreference; labelKey: string; hintKey: string }> = [
  { value: 'flac', labelKey: 'qualityPicker.flacLabel', hintKey: 'qualityPicker.flacHint' },
  { value: 'alac', labelKey: 'qualityPicker.alacLabel', hintKey: 'qualityPicker.alacHint' },
  { value: 'atmos', labelKey: 'qualityPicker.atmosLabel', hintKey: 'qualityPicker.atmosHint' },
  { value: 'aac', labelKey: 'qualityPicker.aacLabel', hintKey: 'qualityPicker.aacHint' },
]

type Props = {
  value: QualityPreference
  onChange: (value: QualityPreference) => void
  className?: string
}

export function QualityPicker({ value, onChange, className }: Props) {
  const { t } = useTranslation()
  return (
    <div className={cx('grid gap-2', className)} role="radiogroup" aria-label={t('qualityPicker.ariaLabel')}>
      {QUALITY_OPTIONS.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              'flex w-full items-start gap-3 rounded-app border px-3 py-2.5 text-left transition-colors',
              selected
                ? 'border-[rgba(var(--accent),0.45)] bg-[rgba(var(--accent),0.14)] text-white'
                : 'border-white/[0.08] bg-white/[0.04] text-white/80 hover:border-white/15 hover:bg-white/[0.07]',
            )}
          >
            <span
              className={cx(
                'mt-1 h-3.5 w-3.5 shrink-0 rounded-full border',
                selected
                  ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent))]'
                  : 'border-white/25 bg-black/20',
              )}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(option.labelKey)}</span>
              <span className="mt-0.5 block text-xs text-white/50">{t(option.hintKey)}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
