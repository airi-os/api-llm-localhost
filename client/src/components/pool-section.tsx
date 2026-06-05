import { useState, type ReactNode } from 'react'
import { PoolBadge } from '@/components/pool-badge'
import type { PoolType } from '@/components/pool-badge'

export function PoolSection({
  pool,
  title,
  children,
}: {
  pool: PoolType
  title: string
  children: ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <section>
      <div
        className="flex items-center gap-2 mb-2 cursor-pointer select-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="text-xs text-muted-foreground">{isExpanded ? '▼' : '▶'}</span>
        <PoolBadge pool={pool} />
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      </div>
      {isExpanded && children}
    </section>
  )
}
