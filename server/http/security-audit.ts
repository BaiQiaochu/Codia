import { appendSecurityAuditEvent } from "../../core/security-audit-log.ts";
import { readAuthPrincipal } from "./capability-guard.ts";

type SecurityAuditPayload = {
  action?: string;
  target?: unknown;
  result?: string;
  secretFields?: string[];
  metadata?: Record<string, unknown>;
  decision?: unknown;
  leaseId?: unknown;
  errorCode?: unknown;
};

export function recordSecurityAuditEvent(c, engine, {
  action,
  target = null,
  result = "success",
  secretFields = [],
  metadata = {},
  decision = null,
  leaseId = null,
  errorCode = null,
}: SecurityAuditPayload = {}) {
  return appendSecurityAuditEvent(engine?.codiaHome || engine?.codiaHome, {
    action,
    target,
    result,
    actor: readAuthPrincipal(c),
    decision,
    leaseId,
    errorCode,
    secretFields,
    metadata,
  });
}
