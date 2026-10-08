const TURN_COMPLETION_NEVER = "never";
const TURN_COMPLETION_WHEN_UNFOCUSED = "when_unfocused";
const TURN_COMPLETION_WHEN_SESSION_UNFOCUSED = "when_session_unfocused";

type NotificationPreferenceInput = {
  turnCompletion?: unknown;
};

export const TURN_COMPLETION_NOTIFICATION_MODES = Object.freeze([
  TURN_COMPLETION_NEVER,
  TURN_COMPLETION_WHEN_UNFOCUSED,
  TURN_COMPLETION_WHEN_SESSION_UNFOCUSED,
]);

export function normalizeTurnCompletionNotificationMode(value: unknown) {
  return TURN_COMPLETION_NOTIFICATION_MODES.includes(value as string)
    ? value
    : TURN_COMPLETION_NEVER;
}

export function normalizeNotificationPreferences(value: unknown = {}) {
  const source: NotificationPreferenceInput = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    turnCompletion: normalizeTurnCompletionNotificationMode(source.turnCompletion),
  };
}

export function mergeNotificationPreferences(existing: unknown = {}, patch: unknown = {}) {
  return normalizeNotificationPreferences({
    ...normalizeNotificationPreferences(existing),
    ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
  });
}
