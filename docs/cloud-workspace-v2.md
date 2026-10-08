# Codia cloud workspace: integrated local and remote modes

> Current upload and recovery extension: [cloud-resumable-uploads-and-recovery.md](cloud-resumable-uploads-and-recovery.md). Historical limits/schema requirements below describe their original stage.

> This document describes the phase-two boundary. The subsequent capability-scoped tool Agent and durable scheduler are documented in [cloud-agent-tasks-and-schedules.md](cloud-agent-tasks-and-schedules.md). Earlier no-tools/no-schedules statements below are historical to phase two.

This change edits the original Codia application. It is not a separate replacement app and does not create a hosted project, bucket, account, key, or public endpoint.

## Working product paths

The normal compiled desktop and mobile app both expose Cloud Workspace. A first-run user can explicitly choose files-only setup, open the main application, save files and use fixed document processing without an AI provider. AI controls remain unavailable until a real provider/model is configured. This choice does not create a fake provider or authorize a different cloud identity.

The selected server repository is authoritative. In local mode this is SQLite plus private server-side object files. Explicit remote mode selects the complete PostgreSQL repository plus the S3 adapter. The renderer does not own a second copy of the database, and file identifiers are canonical UUIDs, not absolute local paths. API reads and each write reauthorize the authenticated user and studio.

- Binary files up to 2 MiB can be saved and downloaded unchanged. Immutable versions have SHA-256/length verification. Unsafe/binary previews are suppressed, text is escaped, and HTML is never executed. Summary tools require text.
- Conversation, workflow and business records are real versioned cloud entities sharing the same repository and object store. Their current pointer uses optimistic CAS. Workflow drafts have a normal title/instruction form. Saving a workflow draft does not execute the old workflow engine.
- Cloud conversations have a transcript and composer. Saving a user message, advancing its current version, enqueueing the model run, and recording outbox events commit in one database transaction after the immutable bytes are verified. Closing the client does not stop the worker. Another authenticated client can reopen the same conversation and read its messages and result.
- Assistant messages are a durable projection of completed run artifacts, inserted after their matching user message on read and deduplicated by run ID. They are not a separate mutable message-table write. Later conversation input includes the projected history. Old immutable input and output versions remain accessible under authorization.
- Imports convert explicitly selected, owner-bound legacy sessions and business/workflow records into the same record format. Imported sessions render as transcripts; imported workflows are inert drafts, not replayed automation. The original source is left intact. Review `migration-legacy-cloud-workspace.md` for dry-run, apply, audits and rollback rules.

## Honest execution boundary

`document-summary` is the original fixed text check/excerpt processor and is explicitly labeled as not using a model.

`agent-summary` and the cloud conversation path use the actual installed Pi Agent SDK and configured Codia model through its real model protocol. The worker launches a fixed trusted Node child with a private temporary HOME, no inherited provider/database/object-store credentials, a memory/time/output limit, no tools, and Node filesystem permission limited to installed dependencies. One actor-bound model credential is passed over stdin for that run, not stored in database rows or renderer state. Node process/permission limits are not an OS sandbox for arbitrary untrusted programs. This is a bounded document/conversation agent; it is not the legacy full tool-using agent, a shell runner, or a multi-tenant general agent sandbox.

The current model resolver accepts only the account/studio owning the existing Codia engine. Other cloud accounts do not borrow that owner's model key. They receive `model_not_configured` until an explicit per-account provider resolver is added. AI invocation also requires chat scope, independently of file-write scope. Legacy demonstration PWA credentials are explicitly ineligible for cloud workspace APIs, even if a studio ID is supplied.

Lease heartbeats, attempt fencing and transactional artifact commit yield at most one visible result per run. Provider calls are at least once: a process crash after a model call but before durable result commit can call the model again on recovery and incur another charge. Stable run/session IDs help trace/cache a call but are not a provider billing-idempotency guarantee. A run gets at most three reclaimed attempts. No claim of exactly-once model billing is made.

Model input is bounded to 128 KiB UTF-8; cloud record edits/messages are bounded to 120 KiB and user messages to 16,000 characters. Imported historical envelopes may be up to 2 MiB and remain readable, but editing/continuing an oversized import requires reducing its current content. There is no multipart upload, unlimited context, model-key vault migration, arbitrary tool execution, team sharing, scheduled cloud workflow execution, or public managed-cloud deployment in this deliverable.

## Configuration and operations

See `../lib/cloud-workspace/migrations/README.md` for exact environment variables, explicit migrations, restricted runtime database role, TLS and S3 configuration. `CODIA_CLOUD_MODE=production` requires remote storage and verified PostgreSQL TLS. Ordinary production-built desktop usage may explicitly remain local; NODE_ENV alone does not activate remote deployment. Partial or mixed remote settings fail rather than silently fall back.

Apply schema 002 for runtime workspace authority; schema 003 adds legacy migration audit/mapping support. Schema 001 is retained as an earlier design artifact, not the active runtime repository. Migrations are not automatically applied at app startup. The database role cannot be SUPERUSER/BYPASSRLS. Transaction-local worker scope is trusted server capability; RLS does not protect against an attacker who can execute arbitrary SQL as that role.

Run shutdown waits for in-flight work. Use the regular server shutdown, back up metadata and object bytes as a matched set, and test restore before changing a production deployment. This code preserves orphan/staged immutable bytes and does not run a destructive garbage collector. Supply approved existing secrets through deployment configuration; never commit them. Do not expose the inherited full Codia server to untrusted public traffic solely because this module supports PostgreSQL/S3.

## Verification interpretation

Tests include native PostgreSQL with restricted roles, actual HTTPS S3-compatible contract transport, actual Agent child plus a local synthetic model-protocol server, authorization, immutable bytes/CAS, crash recovery, migration rollback, component interactions, and normal native application flows. Synthetic model responses prove the execution and durability path, not real-provider quality. Local PostgreSQL and S3 contract fixtures do not prove an externally deployed managed cloud service. The final delivery verification index lists exact commands and pass/fail boundaries.
