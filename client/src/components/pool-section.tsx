import { useState, type ReactNode } from 'react'
import { PoolBadge } from '@/components/pool-badge'
import type { PoolType } from '@/components/pool-badge'

export function PoolSection({
  pool,
  title,
  children,
}: {
  pool?: PoolType
  title: string
  children: ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <section>
      <div
        role="button"
        aria-expanded={isExpanded}
        aria-label={`${title} pool section, ${isExpanded ? 'expanded' : 'collapsed'}`}
        tabIndex={0}
        className="flex items-center gap-2 mb-2 cursor-pointer select-none"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={handleKeyDown}
      >
        <span className="text-xs text-muted-foreground" aria-hidden="true">{isExpanded ? '▼' : '▶'}</span>
        {pool ? <PoolBadge pool={pool} /> : <span className="text-xs text-muted-foreground">unknown</span>}
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      </div>
      {isExpanded && children}
    </section>
  )
}
