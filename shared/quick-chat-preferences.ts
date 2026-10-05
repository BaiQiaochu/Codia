export const DEFAULT_QUICK_CHAT_SHORTCUT = 'Alt+Space';
export const DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES = 10;
const MAX_QUICK_CHAT_REUSE_TIMEOUT_MINUTES = 120;

function normalizeShortcutPart(value: unknown) {
  const raw = String(value ?? '');
  if ((raw === ' ' || raw === '\u00A0' || raw === 'Spacebar') || (raw.length > 0 && raw.trim() === '')) {
    return 'Space';
  }
  const trimmed = raw.trim();
  if (trimmed === 'CmdOrCtrl' || trimmed === 'CommandOrCtrl' || trimmed === 'CtrlOrCommand') {
    return 'CommandOrControl';
  }
  if (trimmed === 'Esc') return 'Escape';
  if (trimmed === 'Spacebar') return 'Space';
  return trimmed;
}

function normalizeShortcut(value: unknown) {
  if (typeof value !== 'string') return DEFAULT_QUICK_CHAT_SHORTCUT;
  const raw = value.trim();
  if (!raw) return DEFAULT_QUICK_CHAT_SHORTCUT;
  const parts = raw.split('+').map(normalizeShortcutPart);
  if (parts.some(part => !part)) return DEFAULT_QUICK_CHAT_SHORTCUT;
  return parts.join('+');
}

function normalizeReuseTimeoutMinutes(value: unknown) {
  if (value === null || value === undefined || value === '') return DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES;
  return Math.max(0, Math.min(MAX_QUICK_CHAT_REUSE_TIMEOUT_MINUTES, Math.round(numeric)));
}

interface QuickChatPreferenceInput {
  shortcut?: unknown;
  reuseTimeoutMinutes?: unknown;
  reuse_timeout_minutes?: unknown;
}

export interface QuickChatPreferences {
  shortcut: string;
  reuseTimeoutMinutes: number;
}

function objectInput(value: unknown): QuickChatPreferenceInput {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as QuickChatPreferenceInput : {};
}

export function normalizeQuickChatPreferences(value: unknown = {}): QuickChatPreferences {
  const source = objectInput(value);
  return {
    shortcut: normalizeShortcut(source.shortcut),
    reuseTimeoutMinutes: normalizeReuseTimeoutMinutes(source.reuseTimeoutMinutes ?? source.reuse_timeout_minutes),
  };
}

export function mergeQuickChatPreferences(existing: unknown = {}, patch: unknown = {}): QuickChatPreferences {
  return normalizeQuickChatPreferences({
    ...normalizeQuickChatPreferences(existing),
    ...objectInput(patch),
  });
}

export default {
  DEFAULT_QUICK_CHAT_SHORTCUT,
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  normalizeQuickChatPreferences,
  mergeQuickChatPreferences,
};
