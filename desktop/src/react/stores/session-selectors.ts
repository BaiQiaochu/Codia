import { sessionScopedListIncludes, sessionScopedValue, type SessionLocatorState } from './session-slice';

type SelectionState = SessionLocatorState & {
  selectedIdsBySession: Record<string, string[]>;
};
type StreamingState = SessionLocatorState & {
  streamingSessions: string[];
};

export const EMPTY_SELECTED_IDS = Object.freeze([]) as readonly string[];
export const EMPTY_STRING_ARRAY = Object.freeze([]) as unknown as string[];
export const EMPTY_ARRAY = Object.freeze([]) as unknown as never[];

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return EMPTY_STRING_ARRAY;
  return value.every(item => typeof item === 'string')
    ? value
    : value.filter((item): item is string => typeof item === 'string') || EMPTY_STRING_ARRAY;
}

export function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : EMPTY_ARRAY as T[];
}

export function selectSelectedIdsBySession(
  state: SelectionState,
  sessionPath: string | null | undefined,
): readonly string[] {
  if (!sessionPath) return EMPTY_SELECTED_IDS;
  const selected = sessionScopedValue(state, state.selectedIdsBySession, sessionPath);
  return Array.isArray(selected) ? selected : EMPTY_SELECTED_IDS;
}

export function selectIsStreamingSession(
  state: StreamingState,
  sessionPath: string | null | undefined,
): boolean {
  return sessionScopedListIncludes(state, toStringArray(state.streamingSessions), sessionPath);
}
