export type ProtectionLevel = 'provider-ban' | 'model-skip' | 'off';

export type ErrorContextKind = '5xx' | 'truncation' | 'retryable';

export interface ErrorContext {
  platform: string;
  kind: ErrorContextKind;
  midStream: boolean;
  modelDbId: number;
  error?: unknown;
}

export interface ThreadProtectionAction {
  banProvider: boolean;
  skipModel: boolean;
  clearStickyIfPinned: boolean;
  reason: string;
}

export function evaluateThreadProtection(_ctx: ErrorContext): ThreadProtectionAction {
  // Placeholder implementation: no protection
  return { banProvider: false, skipModel: false, clearStickyIfPinned: false, reason: 'off' };
}
