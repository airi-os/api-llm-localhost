import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { PoolBadge, type PoolType } from "@/components/pool-badge"

export function PoolSection({
  pool,
  title,
  children,
  className,
}: {
  pool: PoolType
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 p-4",
        className
      )}
    >
      <div className="flex items-center gap-2 mb-3">
        <PoolBadge pool={pool} />
        <h2 className="text-base font-medium tracking-tight">{title}</h2>
      </div>
      <div>{children}</div>
    </div>
  )
}