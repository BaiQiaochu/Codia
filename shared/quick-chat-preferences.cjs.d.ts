export const DEFAULT_QUICK_CHAT_SHORTCUT: string;
export const DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES: number;

export type QuickChatPreferences = {
  shortcut: string;
  reuseTimeoutMinutes: number;
};

export function normalizeQuickChatPreferences(value?: unknown): QuickChatPreferences;
export function mergeQuickChatPreferences(existing?: unknown, patch?: unknown): QuickChatPreferences;

declare const api: {
  DEFAULT_QUICK_CHAT_SHORTCUT: typeof DEFAULT_QUICK_CHAT_SHORTCUT;
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES: typeof DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES;
  normalizeQuickChatPreferences: typeof normalizeQuickChatPreferences;
  mergeQuickChatPreferences: typeof mergeQuickChatPreferences;
};

export default api;
