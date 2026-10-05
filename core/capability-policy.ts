import crypto from "crypto";
import {
  normalizePrincipal,
  principalOwnsLocalConnection,
} from "./security-principal.ts";

type CapabilityTarget = Readonly<{
  kind: string;
  studioId?: string;
  agentId?: string;
  sessionId?: string;
  sessionPath?: string;
  resourceId?: string;
  mountId?: string;
  serverNodeId?: string;
}>;

type CapabilityGrant = {
  grantId?: string;
  principalId?: string;
  status?: string;
  capabilities?: string[];
  constraints?: {
    transportKinds?: string[];
    expiresAt?: string;
  };
  scope?: Record<string, string | undefined>;
};

type AuthorizeCapabilityOptions = {
  principal?: unknown;
  grants?: CapabilityGrant[];
  capability?: string;
  target?: unknown;
  connectionKind?: string;
  now?: string;
};

export function authorizeCapability({
  principal,
  grants = [],
  capability,
  target,
  connectionKind,
  now = new Date().toISOString(),
}: AuthorizeCapabilityOptions = {}) {
  const normalizedTarget = normalizeTarget(target);
  const normalizedCapability = typeof capability === "string" ? capability.trim() : "";
  if (!normalizedCapability) {
    return decision({
      allowed: false,
      reason: "missing_capability",
      capability: normalizedCapability,
      principalId: null,
      target: normalizedTarget,
    });
  }
  if (!principal) {
    return decision({
      allowed: false,
      reason: "missing_principal",
      capability: normalizedCapability,
      principalId: null,
      target: normalizedTarget,
    });
  }

  const normalizedPrincipal = normalizePrincipal(principal) as {
    principalId: string;
    connectionKind?: string;
  };
  if (principalOwnsLocalConnection(normalizedPrincipal)) {
    return decision({
      allowed: true,
      reason: "local_owner",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
    });
  }

  if (!normalizedTarget.studioId) {
    return decision({
      allowed: false,
      reason: "scope_mismatch",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
    });
  }

  const activeGrants = (Array.isArray(grants) ? grants : []).filter((grant) => isGrantActive(grant, now));
  if (activeGrants.length === 0) {
    return decision({
      allowed: false,
      reason: "missing_grant",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
    });
  }

  const transport = connectionKind || normalizedPrincipal.connectionKind;
  for (const grant of activeGrants) {
    if (grant.principalId !== normalizedPrincipal.principalId) continue;
    if (!grantAllowsCapability(grant, normalizedCapability)) continue;
    if (!grantAllowsTransport(grant, transport)) {
      return decision({
        allowed: false,
        reason: "transport_not_allowed",
        capability: normalizedCapability,
        principalId: normalizedPrincipal.principalId,
        target: normalizedTarget,
        grantId: grant.grantId,
      });
    }
    if (!grantScopeContainsTarget(grant.scope, normalizedTarget)) continue;
    return decision({
      allowed: true,
      reason: "allowed",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
      grantId: grant.grantId,
    });
  }

  return decision({
    allowed: false,
    reason: "insufficient_capability",
    capability: normalizedCapability,
    principalId: normalizedPrincipal.principalId,
    target: normalizedTarget,
  });
}

export function capabilityDecisionSummary(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return Object.freeze({
    decisionId: source.decisionId || null,
    allowed: !!source.allowed,
    reason: source.reason || "unknown",
    capability: source.capability || null,
    principalId: source.principalId || null,
    grantId: source.grantId || null,
    target: source.target || null,
  });
}

function decision({
  allowed,
  reason,
  capability,
  principalId,
  target,
  grantId = null,
}: {
  allowed: boolean;
  reason: string;
  capability: string;
  principalId: string | null;
  target: CapabilityTarget;
  grantId?: string | null;
}) {
  return Object.freeze({
    decisionId: `decision_${crypto.randomUUID()}`,
    allowed,
    reason,
    capability,
    principalId,
    grantId,
    target,
  });
}

function normalizeTarget(target: unknown): CapabilityTarget {
  const source = target && typeof target === "object" ? target as Record<string, unknown> : {};
  const out: Record<string, string> = {
    kind: stringOrNull(source.kind) || "unknown",
  };
  for (const key of ["studioId", "agentId", "sessionId", "sessionPath", "resourceId", "mountId", "serverNodeId"]) {
    const value = stringOrNull(source[key]);
    if (value) out[key] = value;
  }
  return Object.freeze(out) as CapabilityTarget;
}

function grantAllowsCapability(grant: CapabilityGrant, capability: string) {
  if (!Array.isArray(grant?.capabilities)) return false;
  if (grant.capabilities.includes(capability)) return true;
  const [namespace] = capability.split(".");
  return grant.capabilities.includes(namespace) || grant.capabilities.includes(`${namespace}.*`);
}

function grantAllowsTransport(grant: CapabilityGrant, connectionKind?: string) {
  const allowed = grant?.constraints?.transportKinds;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(connectionKind);
}

function grantScopeContainsTarget(scope: CapabilityGrant["scope"], target: CapabilityTarget) {
  if (!scope || typeof scope !== "object") return false;
  if (scope.studioId !== target.studioId) return false;
  for (const key of ["agentId", "sessionId", "sessionPath", "resourceId", "mountId", "serverNodeId"]) {
    if (scope[key] && scope[key] !== target[key]) return false;
  }
  return true;
}

function isGrantActive(grant: CapabilityGrant, now: string) {
  if (!grant || grant.status !== "active") return false;
  if (grant.constraints?.expiresAt && Date.parse(grant.constraints.expiresAt) <= Date.parse(now)) return false;
  return true;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
