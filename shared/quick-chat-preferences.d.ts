export interface QuickChatPreferences {
  shortcut: string;
  reuseTimeoutMinutes: number;
}

export declare const DEFAULT_QUICK_CHAT_SHORTCUT: string;
export declare const DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES: number;
export function normalizeQuickChatPreferences(value?: unknown): QuickChatPreferences;
export function mergeQuickChatPreferences(existing?: unknown, patch?: unknown): QuickChatPreferences;
