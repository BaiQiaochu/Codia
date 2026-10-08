import { useStore } from './index';
import type { StoreState } from './index';
import { sessionScopedKey } from './session-slice';

/**
 * Generic updater for keyed-by-session state + compat global field.
 *
 * Usage in ws-message-handler:
 *   updateKeyed('contextBySession', sessionPath, data,
 *     (s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }));
 */
export function updateKeyed<T, K extends keyof StoreState>(
  keyedField: K,
  sessionPath: string,
  value: T,
  toCompat?: (state: StoreState, value: T) => Partial<StoreState>,
) {
  useStore.setState((s) => {
    const key = sessionScopedKey(s, sessionPath) || sessionPath;
    const keyed = { ...(s[keyedField] as Record<string, T>), [key]: value };
    if (key !== sessionPath) delete keyed[sessionPath];
    const compat = (sessionPath === s.currentSessionPath && toCompat)
      ? toCompat(s, value)
      : {};
    return { [keyedField]: keyed, ...compat } as Partial<StoreState>;
  });
}
