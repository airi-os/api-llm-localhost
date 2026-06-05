export type PoolType = 'fast' | 'balanced' | 'smart'

const poolStyles: Record<PoolType, { bg: string; text: string; label: string }> = {
  fast: { bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-700 dark:text-blue-300', label: 'Fast' },
  balanced: { bg: 'bg-amber-100 dark:bg-amber-900/40', text: 'text-amber-700 dark:text-amber-300', label: 'Balanced' },
  smart: { bg: 'bg-purple-100 dark:bg-purple-900/40', text: 'text-purple-700 dark:text-purple-300', label: 'Smart' },
}

export function PoolBadge({ pool }: { pool: PoolType }) {
  const style = poolStyles[pool]
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  )
}
