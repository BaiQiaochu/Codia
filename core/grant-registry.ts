import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const SECURITY_DIR = "security";
export const GRANTS_FILE = "grants.json";

const SCHEMA_VERSION = 1;
const SUBJECT_KINDS = new Set(["user", "device", "agent", "plugin", "bridge", "official_service"]);
const STATUSES = new Set(["active", "revoked", "expired"]);

type GrantScope = {
  studioId?: string;
  agentId?: string;
  sessionId?: string;
  sessionPath?: string;
  resourceId?: string;
  mountId?: string;
  serverNodeId?: string;
};

type GrantConstraints = {
  transportKinds?: string[];
  expiresAt?: string;
  maxBytesPerRequest?: number;
  allowSecretRead?: boolean;
};

type GrantRecord = {
  schemaVersion: number;
  grantId: string;
  principalId: string;
  subjectKind: string;
  scope: GrantScope;
  capabilities: string[];
  constraints: GrantConstraints;
  status: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
};

type GrantRegistry = {
  schemaVersion: number;
  grants: GrantRecord[];
  createdAt: string;
  updatedAt: string;
};

type GrantInput = Partial<GrantRecord> & {
  now?: string;
};

export function ensureGrantRegistry(gsapHome: string, { now = new Date().toISOString() }: { now?: string } = {}) {
  const filePath = grantRegistryPath(gsapHome);
  const existing = readJsonIfPresent(filePath, GRANTS_FILE);
  if (existing) {
    validateGrantRegistry(existing, GRANTS_FILE);
    return existing;
  }
  const registry = createEmptyGrantRegistry(now);
  writeJsonAtomic(filePath, registry);
  return registry;
}

export function loadGrantRegistry(gsapHome: string) {
  ensureGrantRegistry(gsapHome);
  return validateGrantRegistry(readJsonRequired(grantRegistryPath(gsapHome), GRANTS_FILE), GRANTS_FILE);
}

export function createGrant(gsapHome: string, input: GrantInput = {}) {
  const now = input.now || new Date().toISOString();
  const registry = loadGrantRegistry(gsapHome);
  const grant = normalizeGrantRecord({
    schemaVersion: SCHEMA_VERSION,
    grantId: input.grantId || `grant_${crypto.randomUUID()}`,
    principalId: input.principalId,
    subjectKind: input.subjectKind,
    scope: input.scope,
    capabilities: input.capabilities,
    constraints: input.constraints || {},
    status: "active",
    createdAt: now,
    updatedAt: now,
  }, "grant");
  registry.grants.push(grant);
  registry.updatedAt = now;
  persistGrantRegistry(gsapHome, registry);
  return clonePlain(grant);
}

export function findActiveGrantsForPrincipal(gsapHome: string, principalId: string, { now = new Date().toISOString() }: { now?: string } = {}) {
  if (!isNonEmptyString(principalId)) return [];
  const registry = loadGrantRegistry(gsapHome);
  let changed = false;
  const active = [];
  for (const grant of registry.grants) {
    if (grant.status === "active" && grant.constraints?.expiresAt && Date.parse(grant.constraints.expiresAt) <= Date.parse(now)) {
      grant.status = "expired";
      grant.updatedAt = now;
      changed = true;
    }
    if (grant.principalId === principalId && grant.status === "active") {
      active.push(clonePlain(grant));
    }
  }
  if (changed) persistGrantRegistry(gsapHome, registry);
  return active;
}

export function revokeGrant(gsapHome: string, grantId: string, { now = new Date().toISOString() }: { now?: string } = {}) {
  assertNonEmptyString(grantId, "grantId");
  const registry = loadGrantRegistry(gsapHome);
  const grant = registry.grants.find((item) => item.grantId === grantId);
  if (!grant) throw new Error(`grant not found: ${grantId}`);
  grant.status = "revoked";
  grant.revokedAt = now;
  grant.updatedAt = now;
  registry.updatedAt = now;
  persistGrantRegistry(gsapHome, registry);
  return clonePlain(grant);
}

export function persistGrantRegistry(gsapHome: string, registry: GrantRegistry) {
  validateGrantRegistry(registry, GRANTS_FILE);
  writeJsonAtomic(grantRegistryPath(gsapHome), registry);
}

export function grantRegistryPath(gsapHome: string) {
  if (!isNonEmptyString(gsapHome)) throw new Error("gsapHome required");
  return path.join(gsapHome, SECURITY_DIR, GRANTS_FILE);
}

function createEmptyGrantRegistry(now: string): GrantRegistry {
  return {
    schemaVersion: SCHEMA_VERSION,
    grants: [],
    createdAt: now,
    updatedAt: now,
  };
}

function validateGrantRegistry(value: unknown, label: string): GrantRegistry {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  const registry = value as GrantRegistry;
  if (registry.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!Array.isArray(registry.grants)) throw new Error(`invalid ${label}: grants must be an array`);
  const seen = new Set();
  for (const grant of registry.grants) {
    const normalized = normalizeGrantRecord(grant, label);
    if (seen.has(normalized.grantId)) throw new Error(`invalid ${label}: duplicate grantId ${normalized.grantId}`);
    seen.add(normalized.grantId);
  }
  return registry;
}

function normalizeGrantRecord(value: unknown, label: string): GrantRecord {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: grant must be object`);
  const record = value as Record<string, any>;
  if (record.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: grant.schemaVersion must be 1`);
  assertRecordString(record.grantId, label, "grantId");
  assertRecordString(record.principalId, label, "principalId");
  if (!SUBJECT_KINDS.has(record.subjectKind)) throw new Error(`invalid ${label}: subjectKind invalid`);
  if (!STATUSES.has(record.status)) throw new Error(`invalid ${label}: status invalid`);
  if (!isPlainObject(record.scope)) throw new Error(`invalid ${label}: scope must be object`);
  assertRecordString(record.scope.studioId, label, "scope.studioId");
  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) {
    throw new Error(`invalid ${label}: capabilities must be a non-empty array`);
  }
  const capabilities = normalizeStringArray(record.capabilities, "capabilities");
  const constraints = isPlainObject(record.constraints) ? record.constraints as GrantConstraints : {};
  if (constraints.transportKinds !== undefined) {
    normalizeStringArray(constraints.transportKinds, "transportKinds");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    grantId: record.grantId,
    principalId: record.principalId,
    subjectKind: record.subjectKind,
    scope: sanitizeScope(record.scope),
    capabilities,
    constraints: sanitizeConstraints(constraints),
    status: record.status,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  });
}

function sanitizeScope(scope: GrantScope): GrantScope {
  const out: GrantScope = {};
  for (const key of ["studioId", "agentId", "sessionId", "sessionPath", "resourceId", "mountId", "serverNodeId"]) {
    if (isNonEmptyString(scope[key])) out[key] = scope[key].trim();
  }
  return out;
}

function sanitizeConstraints(constraints: GrantConstraints): GrantConstraints {
  const out: GrantConstraints = {};
  if (Array.isArray(constraints.transportKinds)) {
    out.transportKinds = normalizeStringArray(constraints.transportKinds, "transportKinds");
  }
  if (isNonEmptyString(constraints.expiresAt)) out.expiresAt = constraints.expiresAt.trim();
  if (Number.isFinite(constraints.maxBytesPerRequest)) out.maxBytesPerRequest = constraints.maxBytesPerRequest;
  if (typeof constraints.allowSecretRead === "boolean") out.allowSecretRead = constraints.allowSecretRead;
  return out;
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!isNonEmptyString(item)) throw new Error(`${label} entries must be non-empty strings`);
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function readJsonRequired(filePath: string, label: string) {
  const value = readJsonIfPresent(filePath, label);
  if (!value) throw new Error(`${label} not found`);
  return value;
}

function readJsonIfPresent(filePath: string, label: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) throw new Error(`invalid ${label}: ${err.message}`);
    throw new Error(`failed to read ${label}: ${err.message}`);
  }
}

function writeJsonAtomic(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function assertRecordString(value: unknown, fileLabel: string, fieldLabel: string) {
  if (!isNonEmptyString(value)) throw new Error(`invalid ${fileLabel}: ${fieldLabel} required`);
}

function assertNonEmptyString(value: unknown, label: string) {
  if (!isNonEmptyString(value)) throw new Error(`${label} required`);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
