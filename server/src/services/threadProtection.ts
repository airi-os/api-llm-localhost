export type ProtectionLevel = 'provider-ban' | 'model-skip' | 'off';

export type ErrorContextKind = '5xx' | 'truncation' | 'retryable';

export interface ErrorContext {
  platform: string;
  kind: ErrorContextKind;
  /** Whether the error occurred mid-stream (after SSE headers sent) */
  midStream: boolean;
  /** The model DB ID — always available */
  modelDbId: number;
  /** The error object, for logging */
  error?: unknown;
}

export interface ThreadProtectionAction {
  /** Ban the entire platform for this session */
  banProvider: boolean;
  /** Skip just this model */
  skipModel: boolean;
  /** Clear sticky model/key if pinned to this platform */
  clearStickyIfPinned: boolean;
  /** Human-readable reason for logging */
  reason: string;
}

// ── Configuration ──

/**
 * Parse the THREAD_PROTECTION_PLATFORMS env var into a protection map.
 * Format: comma-separated list of `platform:level` pairs, e.g.
 * "longcat:provider-ban,groq:model-skip"
 *
 * When unset or empty, returns the default protection map that preserves
 * existing LongCat behavior (longcat → provider-ban) and applies model-skip
 * to all other platforms. This ensures full backward compatibility.
 */
function parseProtectionConfig(raw: string | undefined): Map<string, ProtectionLevel> {
  const map = new Map<string, ProtectionLevel>();

  if (raw && raw.trim().length > 0) {
    for (const pair of raw.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const [platform, level] = trimmed.split(':');
      if (!platform || !level) continue;
      const normalizedLevel = level.trim().toLowerCase();
      if (normalizedLevel === 'provider-ban' || normalizedLevel === 'model-skip' || normalizedLevel === 'off') {
        map.set(platform.trim().toLowerCase(), normalizedLevel as ProtectionLevel);
      }
    }
  }

  // Default: longcat → provider-ban (preserves existing behavior)
  // All other platforms → model-skip
  if (!map.has('longcat')) {
    map.set('longcat', 'provider-ban');
  }

  return map;
}

const protectionMap = parseProtectionConfig(process.env.THREAD_PROTECTION_PLATFORMS);

/**
 * Look up the protection level for a given platform.
 * Returns 'model-skip' for platforms not explicitly configured (the safe default).
 * Exported for use in proxy.ts sticky cooldown generalization.
 */
export function getProtectionLevel(platform: string): ProtectionLevel {
  return protectionMap.get(platform.toLowerCase()) ?? 'model-skip';
}

// ── Decision matrix ──

/**
 * Evaluate error context against the configured protection rules and return
 * the action the proxy should take.
 *
 * Decision matrix:
 * | Protection Level | 5xx              | truncation       | retryable        |
 * |------------------|------------------|------------------|------------------|
 * | provider-ban     | banProvider=true | banProvider=true | banProvider=true |
 * |                  | skipModel=false  | skipModel=false  | skipModel=false  |
 * |                  | clearSticky=true | clearSticky=true | clearSticky=true |
 * | model-skip       | banProvider=false| banProvider=false| banProvider=false|
 * |                  | skipModel=true   | skipModel=true   | skipModel=true   |
 * |                  | clearSticky=false| clearSticky=false| clearSticky=false|
 * | off              | all false        | all false        | all false        |
 */
export function evaluateThreadProtection(ctx: ErrorContext): ThreadProtectionAction {
  const level = getProtectionLevel(ctx.platform);

  switch (level) {
    case 'provider-ban':
      return {
        banProvider: true,
        skipModel: false,
        clearStickyIfPinned: true,
        reason: `provider-ban:${ctx.kind}${ctx.midStream ? ':mid-stream' : ''}`,
      };

    case 'model-skip':
      return {
        banProvider: false,
        skipModel: true,
        clearStickyIfPinned: false,
        reason: `model-skip:${ctx.kind}${ctx.midStream ? ':mid-stream' : ''}`,
      };

    case 'off':
      return {
        banProvider: false,
        skipModel: false,
        clearStickyIfPinned: false,
        reason: 'off',
      };
  }
}