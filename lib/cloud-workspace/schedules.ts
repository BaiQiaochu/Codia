import { CloudWorkspaceError, validName, type CloudRow } from './store.ts';
import type { CreateCloudSchedule } from './repository.ts';

export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
export const MAX_SCHEDULE_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
// Keep ISO dates renderable (through year 9999), and reserve one maximum interval
// so advancing a due occurrence cannot overflow either date or integer bounds.
export const MAX_SCHEDULE_TIMESTAMP = 253_402_300_799_999 - MAX_SCHEDULE_INTERVAL_MS;

export function scheduleTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SCHEDULE_TIMESTAMP) throw new CloudWorkspaceError('invalid_schedule_time');
  return value;
}
export function scheduleLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new CloudWorkspaceError('invalid_schedule_limit');
  return value;
}
export function scheduleRevision(value: number, enabled: boolean): void {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new CloudWorkspaceError('invalid_schedule_revision');
  if (typeof enabled !== 'boolean') throw new CloudWorkspaceError('invalid_schedule_enabled');
}
export function normalizeSchedule(input: CreateCloudSchedule) {
  if (!input || typeof input !== 'object') throw new CloudWorkspaceError('invalid_schedule');
  const name = validName(input.name);
  if (!['document-summary', 'agent-summary', 'agent-task'].includes(input.operation)) throw new CloudWorkspaceError('unsupported_operation');
  if (typeof input.inputVersion !== 'string' || !input.inputVersion) throw new CloudWorkspaceError('not_found', 404);
  if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestKey)) throw new CloudWorkspaceError('invalid_request_key');
  scheduleTimestamp(input.firstRunAt);
  if (input.intervalMs !== null && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < MIN_SCHEDULE_INTERVAL_MS || input.intervalMs > MAX_SCHEDULE_INTERVAL_MS)) throw new CloudWorkspaceError('invalid_schedule_interval');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new CloudWorkspaceError('invalid_schedule_enabled');
  return { name, inputVersion: input.inputVersion, operation: input.operation, firstRunAt: input.firstRunAt, intervalMs: input.intervalMs, enabled: input.enabled === true };
}
export function sameScheduleSpecification(stored: unknown, desired: ReturnType<typeof normalizeSchedule>): boolean {
  const old = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return !!old && typeof old === 'object' && Object.entries(desired).every(([key, value]) => (old as CloudRow)[key] === value);
}
export function nextScheduleOccurrence(due: number, interval: number | null, timestamp: number): number {
  if (interval === null) return due;
  // BigInt avoids rounding on large, but still valid, epoch-millisecond values.
  return Number(BigInt(due) + ((BigInt(timestamp) - BigInt(due)) / BigInt(interval) + 1n) * BigInt(interval));
}

/** Only persisted, deterministic admission failures may pause a schedule.
 * Database outages, migration errors and unknown exceptions must remain retryable.
 */
export function scheduleDispatchRejection(error: unknown): string | null {
  return error instanceof CloudWorkspaceError && [
    'document_input_too_large', 'agent_input_too_large', 'not_found',
    'unsupported_operation', 'invalid_request_key', 'idempotency_conflict',
  ].includes(error.code) ? error.code : null;
}
