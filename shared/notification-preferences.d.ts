export type TurnCompletionNotificationMode = "never" | "when_unfocused" | "when_session_unfocused";

export interface NotificationPreferences {
  turnCompletion: TurnCompletionNotificationMode;
}

export declare const TURN_COMPLETION_NOTIFICATION_MODES: readonly TurnCompletionNotificationMode[];
export function normalizeTurnCompletionNotificationMode(value: unknown): TurnCompletionNotificationMode;
export function normalizeNotificationPreferences(value?: unknown): NotificationPreferences;
export function mergeNotificationPreferences(existing?: unknown, patch?: unknown): NotificationPreferences;
