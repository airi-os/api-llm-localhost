import { cn } from "@/lib/utils"

const poolConfig = {
  fast: {
    icon: "⚡",
    label: "Fast",
    className: "bg-emerald-100 text-green-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  balanced: {
    icon: "⚖️",
    label: "Balanced",
    className: "bg-slate-100 text-gray-700 dark:bg-slate-800 dark:text-slate-300",
  },
  smart: {
    icon: "🧠",
    label: "Smart",
    className: "bg-purple-100 text-indigo-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
} as const

export type PoolType = keyof typeof poolConfig

export function PoolBadge({
  pool,
  className,
}: {
  pool: PoolType
  className?: string
}) {
  const config = poolConfig[pool]

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        config.className,
        className
      )}
    >
      <span className="shrink-0">{config.icon}</span>
      {config.label}
    </span>
  )
}