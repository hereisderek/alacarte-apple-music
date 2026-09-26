import { useTranslation } from 'react-i18next'

import type { HealthReport } from '../api/client'
import { cx } from '../lib/cx'
import { Badge } from './Badge'
import i18n from '../i18n'

type Props = {
  health: HealthReport | null
  loading: boolean
  variant?: 'default' | 'shell'
}

export function HealthPill({ health, loading, variant = 'default' }: Props) {
  const { t } = useTranslation()
  const shellClass = variant === 'shell' ? 'h-10 px-3.5 text-[0.8125rem] leading-none group-hover:text-accent group-hover:border-[rgba(var(--accent),0.3)] group-hover:bg-[rgba(var(--accent),0.12)]' : ''
  if (loading || !health) {
    return <Badge className={shellClass}>{t('healthPill.checking')}</Badge>
  }
  if (health.ok) {
    if (health.wrapper?.stallRecent) {
      return (
        <Badge
          variant="warn"
          className={shellClass}
          title={t('healthPill.stalledRecoveredTitle')}
        >
          ● {t('healthPill.recovered')}
        </Badge>
      )
    }
    return <Badge variant="ok" className={shellClass}>● {t('healthPill.ready')}</Badge>
  }
  const wrapperDown = isWrapperDown(health)
  let label = t('healthPill.issue')
  let title = t('healthPill.somethingNotReady')
  if (wrapperDown) {
    label = t('healthPill.signInRequired')
    title = t('healthPill.wrapperOfflineTitle')
  } else if (!health.appleToken?.ok) {
    label = t('healthPill.appleToken')
    title = t('healthPill.appleTokenTitle')
  } else if (!health.music?.ok) {
    label = t('healthPill.musicFolder')
    title = t('healthPill.musicFolderTitle')
  } else {
    const partial: string[] = []
    if (!health.wrapper?.decrypt?.ok) partial.push('decrypt')
    if (!health.wrapper?.m3u8?.ok) partial.push('m3u8')
    if (!health.wrapper?.account?.ok) partial.push('account')
    label = t('healthPill.wrapperPartial', { detail: partial.join(', ') })
    title = label
  }
  return (
    <Badge
      variant="warn"
      className={cx('max-w-[260px] truncate', shellClass)}
      title={title}
    >
      ● {label}
    </Badge>
  )
}

function isWrapperDown(health: HealthReport): boolean {
  return (
    !health.wrapper?.decrypt?.ok &&
    !health.wrapper?.m3u8?.ok &&
    !health.wrapper?.account?.ok
  )
}

export function getHealthPillTarget(health: HealthReport | null): string {
  if (!health) return '/status'
  return isWrapperDown(health) ? '/settings' : '/status'
}

export function getHealthPillAriaLabel(health: HealthReport | null): string {
  if (!health) return i18n.t('healthPill.openStatus')
  return isWrapperDown(health) ? i18n.t('healthPill.openSettings') : i18n.t('healthPill.openStatus')
}
