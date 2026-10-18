export const CAPABILITIES = ['text', 'tool', 'vision', 'structured'] as const;
export type ModelCapability = typeof CAPABILITIES[number];
export type QualificationState = 'pass' | 'fail' | 'unknown';
export type CapabilityStatus = 'pass' | 'fail' | 'unsupported' | 'blocked' | 'not-run';
export const QUALIFICATION_SUITE_VERSION = 'codia-capabilities-v1';
export const QUALIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export interface QualificationBudget {
  maxCalls: number;
  maxTokens: number;
  maxUsd: number;
  maxDurationMs: number;
}
export interface CapabilityResult {
  capability: ModelCapability;
  status: CapabilityStatus;
  code: string;
  suggestion: string;
  requestId: string | null;
  responseDigest: string | null;
  durationMs: number;
}
export interface QualificationReport {
  id: string;
  suiteVersion: string;
  model: { id: string; provider: string; api: string };
  fingerprint: string;
  provenance: 'configured-provider' | 'test-injected';
  mediaAccounting: 'fixture-input-token-estimate-confirmed' | 'unconfirmed';
  status: 'running' | 'completed' | 'interrupted';
  startedAt: number;
  finishedAt: number | null;
  expiresAt: number;
  results: CapabilityResult[];
  budget: Record<string, unknown> | null;
  note: string;
}
export interface QualificationInspection {
  state: QualificationState;
  reason: string;
  fingerprint: string | null;
  report: QualificationReport | null;
}
