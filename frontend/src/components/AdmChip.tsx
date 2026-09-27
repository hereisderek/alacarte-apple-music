import { cx } from '../lib/cx'

export const ADM_DESCRIPTION =
  "Apple Digital Master: mastered to Apple's spec from a high-resolution master"

// Marks single tracks as Apple Digital Masters where the whole album is not.
export function AdmChip({ className }: { className?: string }) {
  return (
    <span
      title={ADM_DESCRIPTION}
      aria-label="Apple Digital Master"
      className={cx(
        'ml-1.5 inline-flex items-center rounded border border-[rgba(var(--accent),0.35)] px-1 py-px align-middle text-[10px] font-semibold uppercase leading-none tracking-wider text-[rgb(var(--accent))]',
        className,
      )}
    >
      ADM
    </span>
  )
}
