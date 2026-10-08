# Workspace database deployment and verification

The running cloud-workspace service uses **002-workspace-runtime.sql** plus
**004-cloud-agent-tasks.sql** and **005-resumable-uploads.sql**, schema `codia_workspace`. The earlier
`001-cloud-workspaces.sql` is a standalone design
schema; it is not a prerequisite, and its tables are not the runtime authority.
No SQLite records are silently copied when a backend changes.

## Explicit setup

1. Use a reviewed migration/owner database identity to apply `002` once.
2. Apply `003-legacy-migration.sql` if using the legacy import/rollback tool.
   Apply `004-cloud-agent-tasks.sql` for this runtime, whether or not `003` is used.
   It extends existing run operations and adds schedules without rewriting prior
   files, versions, runs, artifacts, events, or legacy import metadata. Apply each
   migration once; the runtime never auto-applies PostgreSQL migrations.
   Apply `005-resumable-uploads.sql` after `004` for resumable uploads and linked
   retries; existing files, versions, runs and schedules are retained.
3. Configure an existing trusted-server runtime role with schema `USAGE`, table
   `SELECT, INSERT, UPDATE`, and sequence `USAGE, SELECT`. It must not be a
   superuser or `BYPASSRLS` role. The migrator also needs the privileges documented
   by its adapter. This project does not create deployment roles or credentials.
4. Set `CODIA_CLOUD_MODE=production`, `CODIA_CLOUD_DATABASE=postgres`, and
   `CODIA_CLOUD_OBJECT_STORE=s3`. Provide `CODIA_CLOUD_DATABASE_URL` and set
   `CODIA_CLOUD_DATABASE_TLS=verify-full`; supply `CODIA_CLOUD_DATABASE_CA` when a
   private trusted CA is needed. URL SSL override parameters are rejected.
5. Provide `CODIA_CLOUD_S3_ENDPOINT`, `CODIA_CLOUD_S3_BUCKET`,
   `CODIA_CLOUD_S3_REGION`, `CODIA_CLOUD_S3_ACCESS_KEY_ID`, and
   `CODIA_CLOUD_S3_SECRET_ACCESS_KEY`, with optional
   `CODIA_CLOUD_S3_SESSION_TOKEN`. Use existing credentials delivered securely by
   the deployment environment. S3 endpoints must be HTTPS origins; the adapter
   uses path-style addressing and requires conditional writes plus SHA-256 object
   metadata. Configure the bucket privately using your deployment policy.

Startup validates the configuration and migration marker. It never applies
migrations, provisions resources, creates credentials, modifies database security,
or silently falls back to local persistence after an error. A missing migration
or unavailable database prevents cloud-runtime initialization.
The required marker is now version **5** (version 2 remains recorded as history).
Schedule methods also explicitly reject a missing v4 migration with
`cloud_database_migration_required`, before accessing schedule tables. Existing
runtime identities need their authorized table privileges to include the new
`schedules`, `uploads`, and `upload_chunks` tables. The migrations grant no new roles or permissions themselves.

`NODE_ENV=production` by itself does not select hosted cloud mode because packaged
local desktop builds also use it. Without the hosted mode flag or cloud selectors,
the default is SQLite plus local immutable object storage. Explicit remote
selectors always require a complete PostgreSQL-plus-S3 pair. Plaintext PostgreSQL
is supported only for loopback development, never hosted production.

## Trust boundary

Every owner operation sets transaction-local tenant/actor context, explicitly
clears the worker capability, uses parameterized SQL with explicit owner/studio
predicates, and runs under forced RLS. Internal queue/outbox/staging operations set
`codia.trusted_worker=on` only within their own transaction; it is reset at commit
or rollback. Worker methods are not HTTP endpoints and do not accept user-provided
identity. A trusted database login can set these context variables itself: RLS is
**not** a defense against arbitrary SQL execution by someone holding that login.
Do not distribute runtime database credentials to browsers or end users. Separate
worker connections may be configured by constructing a dedicated repository, but
the bundled server currently uses a shared trusted runtime pool.

The database enforces owner-aware foreign keys, immutable ready version metadata,
append-only events, atomic version CAS, run attempt fencing and lease expiry.
Claims use `FOR UPDATE SKIP LOCKED`. Server database time is used for leases unless
an explicit test timestamp is passed. At most three attempts are allowed.
Outbox sequence allocation is serialized per workspace, preventing lower event
IDs from becoming visible after a reconnect cursor advances past them. Concurrent
publishers serialize their visibility boundary and publish at most 2,000 records
per call; further calls drain the backlog.

## Resumable uploads and explicit retry (schema 005)

The runtime now requires schema marker 5 as well as the prior schedule marker.
Owner-scoped uploads and immutable upload chunks use forced RLS and scoped foreign
keys. The runtime role needs SELECT/INSERT/UPDATE on these two new tables; no role,
credential, DELETE privilege, or bucket policy is created by the migration.
`runs.retry_of` links a new explicit retry to its failed/cancelled source and
preserves its input/operation. Foreign keys and triggers reject cross-scope or
mutable lineage. Existing rows acquire a NULL retry link and remain readable.

Uploads accept 32 MiB through exact 1 MiB raw chunks, retain their original intent
for idempotency, and expire after 24 hours. Final assembly is bounded and buffered.
Owner/studio budgets span all workspaces: eight active sessions/128 MiB, plus a
rolling 24-hour retained budget of 32 sessions/512 MiB over every state. Cancel and
completion do not refund the retained budget. At most two session completions
assemble buffers concurrently per API process; database finalization fences
independent servers and restarts. Cancel never rolls back an already committed
version. Uncertain PUT/complete results verify the original immutable bytes and
reuse the same reserved version before publishing.

Temporary immutable objects and orphaned final writes are retained; expiry does
not delete bytes. Hosted operators need a separately reviewed, temporary-prefix
lifecycle with grace beyond the upload window. Local key-hashed object envelopes
need metadata-aware collection, not a blind mtime sweep. See
[the full upload/recovery contract](../../../docs/cloud-resumable-uploads-and-recovery.md)
for API, memory, resumption, retention, processing limits and rollback boundaries.

## Durable schedule semantics

Schedules pin a ready, immutable input version and support `document-summary`,
`agent-summary`, and `agent-task`. `agent-conversation` is deliberately excluded.
Creation defaults to **paused**; dispatch requires explicit enablement. The
original normalized creation intent is retained privately for idempotency, so a
retry with the same key returns the existing schedule after execution or state
changes. A changed name, input, operation, first due time, interval, or original
enabled flag produces `idempotency_conflict`.

Times are nonnegative integer UTC epoch milliseconds, bounded so both the input
and the next occurrence remain ISO-renderable through year 9999. Recurring
intervals must be safe integers from **60 seconds through 366 days**, inclusive;
`null` is one-shot. Revisions start at 1. Pause/resume uses expected-revision CAS;
stale edits produce `schedule_conflict`. Completed one-shots cannot be re-enabled.
Pausing prevents future dispatch, but does not cancel a run already enqueued.

Every due occurrence creates its durable run and advances the schedule in one
transaction. PostgreSQL dispatchers claim with `FOR UPDATE SKIP LOCKED` and keep
one short transaction per occurrence; SQLite uses an immediate transaction.
The generated request key is `schedule_<full schedule UUID>_<due epoch ms>`.
The `schedule_` run-key prefix is reserved for the dispatcher. Retrying dispatch
after a crash cannot create a second run for the same occurrence.

Missed intervals **coalesce** into one run with the original earliest due key;
the next due time advances to the first cadence-aligned instant strictly after
the dispatch timestamp. There is no burst catch-up. If the last run is still
queued or running, the occurrence is skipped, its next due time still advances,
and `schedule.skipped` records the overlap. Expired running leases remain active
until the ordinary worker recovery path finishes or fails them. One-shots become
completed when dispatched. Each dispatch call examines at most its bounded limit
(default 100, maximum 1,000), and returns the number of runs created, not skips.

Creation, pause/resume, dispatch, and overlap skips are durable outbox events.
Cancellation is owner-authorized and atomically changes queued/running runs to
`failed` with `error='cancelled'`, clears the lease, and records `run.cancelled`.
Repeated cancellation is idempotent; other terminal results are unchanged.
Cancelled executors cannot renew a lease or publish an artifact. Successful
`agent-task` output is a single immutable `task-session-<full run UUID>.json`
bundle; existing summary output naming remains unchanged.

SQLite creates the schedule schema on the next open while preserving existing
tables and records. PostgreSQL upgrades are explicit. Both authorities enforce
immutable schedule specifications; PostgreSQL additionally enforces scoped
foreign keys and forced owner/tenant RLS on the new schedule table.

## Verification

Offline contracts:

```
npx vitest run tests/cloud-storage-adapters.test.ts tests/cloud-workspace-config.test.ts
npx vitest run tests/cloud-schedules.test.ts
```

Real PostgreSQL tests (use **only an isolated disposable loopback database** whose
name begins with `codia_`; fixture setup creates/drops a uniquely named database and synthetic
non-login role):

```
CODIA_TEST_POSTGRES_URL=... npx vitest run tests/cloud-postgres-live.test.ts
CODIA_TEST_POSTGRES_URL=... npx vitest run tests/cloud-schedules-postgres.test.ts
```

These tests are skipped without that explicit variable. They execute real RLS
under a `NOSUPERUSER NOBYPASSRLS` role, concurrent uploads/claims, idempotency,
lease recovery/fencing, atomic upload-plus-enqueue rollback, immutable history,
scoped foreign keys, outbox replay, and restart reads. A synthetic fixture role is
not a deployment identity. S3 unit tests use a fake HTTP transport and a published
AWS signature vector; they must not be described as validation against a managed
S3 account. A real provider/bucket and production PostgreSQL deployment still
require environment-specific acceptance testing with authorized existing access.
The schedule suite creates a separate disposable database and uses PostgreSQL's
existing non-login `pg_database_owner` role, without creating any role or secret.
It covers concurrent dispatcher idempotency, reconnect persistence, overlap skips,
coalescing, CAS, atomic rollback, owner RLS, immutable intent, and cancellation.
