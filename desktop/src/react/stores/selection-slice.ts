import { sessionScopedKey, sessionScopedValue } from './session-slice';
import { toStringArray } from './session-selectors';

export interface SelectionSlice {
  selectedIdsBySession: Record<string, string[]>;
  setMessageSelection: (sessionPath: string, messageIds: string[]) => void;
  addMessagesToSelection: (sessionPath: string, messageIds: string[]) => void;
  toggleMessageSelection: (sessionPath: string, messageId: string) => void;
  clearSelection: (sessionPath: string) => void;
}

export const createSelectionSlice = (
  set: (partial: Partial<SelectionSlice> | ((s: SelectionSlice) => Partial<SelectionSlice>)) => void,
): SelectionSlice => ({
  selectedIdsBySession: {},

  setMessageSelection: (sessionPath, messageIds) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const next = Array.from(new Set(toStringArray(messageIds)));
    const copy = { ...(s.selectedIdsBySession || {}) };
    delete copy[sessionPath];
    if (next.length > 0) copy[key] = next;
    else delete copy[key];
    return { selectedIdsBySession: copy };
  }),

  addMessagesToSelection: (sessionPath, messageIds) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const current = toStringArray(sessionScopedValue(s as any, s.selectedIdsBySession, sessionPath));
    const next = Array.from(new Set([...current, ...toStringArray(messageIds)]));
    const copy = { ...(s.selectedIdsBySession || {}) };
    delete copy[sessionPath];
    if (next.length > 0) copy[key] = next;
    else delete copy[key];
    return {
      selectedIdsBySession: copy,
    };
  }),

  toggleMessageSelection: (sessionPath, messageId) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const current = toStringArray(sessionScopedValue(s as any, s.selectedIdsBySession, sessionPath));
    const next = current.includes(messageId)
      ? current.filter(id => id !== messageId)
      : [...current, messageId];
    const copy = { ...(s.selectedIdsBySession || {}) };
    delete copy[sessionPath];
    if (next.length > 0) copy[key] = next;
    else delete copy[key];
    return {
      selectedIdsBySession: copy,
    };
  }),

  clearSelection: (sessionPath) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const copy = { ...(s.selectedIdsBySession || {}) };
    delete copy[key];
    delete copy[sessionPath];
    return { selectedIdsBySession: copy };
  }),
});
