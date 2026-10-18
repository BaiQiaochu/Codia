# Approval binding and recovery

Approval cards and the existing gateway share a stable action ID, canonical parameter digest, single-action scope and expiry. Parameters are rechecked after the asynchronous approval; a changed target or expired decision cannot execute. Card/store presentation is redacted using the existing redactor. Permission mode and sandbox policy remain authoritative; no second approval authority is introduced.

ConfirmStore optionally persists redacted decision evidence in approvals.json. Restarted pending approvals appear as interrupted evidence, never executable Promise continuations; a fresh request is required. A failed persistence operation cannot authorize execution. The task console links pending/interrupted entries to the original session.

The per-tool ledger adds durable planned/running/succeeded/unknown evidence, bound to the same action and scope. An unknown write is not replayed. See tool-action-ledger.md for exact ID and external-service limits.

Deterministic tests cover changed parameters, expiry, redacted credentials, process restart evidence and non-reusable decisions. This does not claim new MCP OAuth/security audit findings or broader sandbox guarantees.
