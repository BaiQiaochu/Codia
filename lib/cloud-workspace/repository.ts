import type { CloudActor, CloudRow, CloudWorkspaceStore } from './store.ts';

export type CloudOperation = 'document-summary' | 'agent-summary' | 'agent-conversation' | 'agent-task';
export type CloudScheduleOperation = Exclude<CloudOperation, 'agent-conversation'>;
export type CreateCloudSchedule = {
  name: string; inputVersion: string; operation: CloudScheduleOperation; requestKey: string;
  firstRunAt: number; intervalMs: number | null; enabled?: boolean;
};
export type StagedCloudVersion = { file: CloudRow; version: CloudRow; expected: string | null };
export type EnqueueCloudRun = { requestKey: string; operation: CloudOperation };
export type CloudOutput = { objectKey: string; size: number; sha256: string };

/** Service boundary: all authority and transaction operations are asynchronous. */
export interface CloudWorkspaceRepository {
  readonly kind: string;
  close(): Promise<void>;
  workspace(actor: CloudActor, workspaceId: string): Promise<CloudRow>;
  listWorkspaces(actor: CloudActor): Promise<CloudRow[]>;
  createWorkspace(actor: CloudActor, name: string): Promise<CloudRow>;
  file(actor: CloudActor, fileId: string): Promise<CloudRow>;
  version(actor: CloudActor, versionId: string): Promise<CloudRow>;
  listFiles(actor: CloudActor, workspaceId: string): Promise<CloudRow[]>;
  fileSummary(actor: CloudActor, fileId: string): Promise<CloudRow>;
  versions(actor: CloudActor, fileId: string): Promise<CloudRow[]>;
  stageVersion(actor: CloudActor, workspaceId: string, name: string, size: number, sha256: string, fileId?: string, expectedVersion?: string): Promise<StagedCloudVersion>;
  finalizeVersion(actor: CloudActor, versionId: string, expected: string | null, enqueue?: EnqueueCloudRun): Promise<{file: CloudRow; version: CloudRow; run?: CloudRow}>;
  rejectVersion(versionId: string): Promise<void>;
  reconcileStaging(timestamp?: number, graceMs?: number): Promise<number>;
  createRun(actor: CloudActor, workspaceId: string, inputVersion: string, requestKey: string, operation?: CloudOperation): Promise<CloudRow>;
  listRuns(actor: CloudActor, workspaceId: string): Promise<CloudRow[]>;
  cancelRun(actor: CloudActor, runId: string): Promise<CloudRow>;
  listSchedules(actor: CloudActor, workspaceId: string): Promise<CloudRow[]>;
  schedule(actor: CloudActor, scheduleId: string): Promise<CloudRow>;
  createSchedule(actor: CloudActor, workspaceId: string, input: CreateCloudSchedule): Promise<CloudRow>;
  setScheduleEnabled(actor: CloudActor, scheduleId: string, expectedRevision: number, enabled: boolean): Promise<CloudRow>;
  dispatchDueSchedules(timestamp?: number, limit?: number): Promise<number>;
  run(actor: CloudActor, runId: string): Promise<{run: CloudRow; events: CloudRow[]; artifacts: CloudRow[]}>;
  claim(leaseMs?: number, timestamp?: number): Promise<CloudRow | null>;
  renewLease(run: CloudRow, leaseMs?: number, timestamp?: number): Promise<boolean>;
  complete(run: CloudRow, output: CloudOutput, timestamp?: number): Promise<{fileId: string; versionId: string}>;
  fail(run: CloudRow, code: string): Promise<void>;
  publishOutbox(): Promise<void>;
  events(actor: CloudActor, workspaceId: string, after?: number): Promise<{events: CloudRow[]; cursor: number}>;
}

/** Keeps existing synchronous local callers compatible without leaking db handles. */
export function asAsyncWorkspaceRepository(store: CloudWorkspaceStore | CloudWorkspaceRepository): CloudWorkspaceRepository {
  return new Proxy({ kind: store.kind } as CloudWorkspaceRepository, {
    get(target, key) {
      if (key === 'kind') return target.kind;
      const method = Reflect.get(store, key);
      if (typeof method !== 'function') return undefined;
      return async (...args: unknown[]) => method.apply(store, args);
    },
  });
}
