# Legacy records → cloud workspace migration

> Import remains inert. For the later explicit saved-workflow conversion and new durable cloud schedules, see [cloud-agent-tasks-and-schedules.md](cloud-agent-tasks-and-schedules.md). No historical enabled/running status is automatically activated.

## What is implemented

The operator-only importer reads explicitly selected, existing Codia record stores and imports their real structured content into immutable cloud file versions. PostgreSQL and SQLite use the same transactional migration state machine. PostgreSQL stores authoritative metadata in `codia_workspace`; objects use the configured private S3 adapter. SQLite/local objects remain an explicitly labelled development destination.

Imported records use the cloud record API's envelope and names:

- `record-conversation-<canonical-file-id>.json` for session JSONL
- `record-workflow-<canonical-file-id>.json` for workflow journals/activity and automation records
- `record-business-<canonical-file-id>.json` for aftersales tasks, project catalog and session sidecars
- An immutable `legacy-manifest-<id>.json` maps source-relative identities to `cloud-file:<id>` resource identifiers

Envelope: `{schemaVersion:1,id,kind,title,data:{legacy:{sourceId,sourceKey,relativePath,originalSha256,execution:'inert-snapshot'},content},createdAt,updatedAt}`. Timestamps initially use the source file's modification time. The `content` field preserves parsed JSON objects/JSONL records, including original IDs and relationships. A file ID is a deterministic, tenant/user/workspace/source-scoped UUID. Moving the same installation to another approved root does not change that canonical file ID. The manifest is the cloud identity map; embedded legacy path references are provenance, never runtime filesystem authority.

These records can be listed and read through the cloud structured record API on another authenticated client. Cloud edits retain the record API’s 120 KiB request-data limit and agent execution retains its separate bounded-input limit; importing a readable large archive does not remove those bounds. This is **not a conversion of the original session coordinator, workflow engine or automation scheduler**: imported pending/running statuses are historical content and do not restart execution. Existing legacy session/aftersales/cron routes keep their own persistence until separately cut over. Importing an automation never enables it. Bytecode, scripts, native SQLite databases and account/provider configuration are not imported.

## Source authorization and selection

Use this from the trusted Linux operator environment with permission to read the selected source and write the existing destination workspace. Do not expose this CLI or `scanLegacyData` to an HTTP/renderer route. Never take a source path or target owner from an untrusted request. This importer cannot prove ownership of historical global files because the legacy stores lack reliable tenant attribution.

The programmatic scan requires `{sourceRoot,sourceId,owner,agentIds,includeSharedState?}`; planning rejects an owner that differs from the scan's assigned owner. CLI checks destination ownership before opening source files. `--ack-source-ownership` means the operator has reviewed that every selected record belongs in this exact user/studio/workspace. Shared stores require the additional explicit `--include-shared-state` opt-in. Neither flag creates authorization for a new external recipient or grants filesystem access.

Only these existing paths under the explicitly named root are eligible:

| Scope | Known stores | Cloud kind |
| --- | --- | --- |
| Selected agent | `agents/<id>/sessions/*.jsonl`, `sessions/archived/*.jsonl` | conversation |
| Selected agent | `agents/<id>/workflow-sessions/<run>/*.jsonl` | conversation |
| Selected agent | `sessions/session-meta.json`, `sessions/session-titles.json`, `sessions/titles.json` | business |
| Selected agent | `workflow-journals/*.jsonl` | workflow |
| Selected agent | `desk/cron-jobs.json`, `desk/cron-runs/*.jsonl` | workflow |
| Explicit shared state | `workflow-activity.json` | workflow |
| Explicit shared state | `aftersales/tasks.json` | business |
| Explicit shared state | `user/session-projects.json` | business |

There is no guessed home directory, recursive upload of the installation, external attachment resolution, or selection of every agent. In particular `auth.json`, provider settings, `.env`, agent configuration, keys, arbitrary uploads and model credentials are excluded. Known credential-like names/JSON keys and recognizable token/private-key patterns cause an entire candidate to be skipped. This is conservative screening, not a guarantee of finding every secret in free-form conversation text: review the source scope and dry-run omissions before sending private records to an approved destination. False positives require a separately reviewed sanitized source copy, not disabling checks.

Traversal is descriptor-relative on Linux with `O_NOFOLLOW` on every directory/file component. Root symlinks, nested symlinks, hardlinks, non-regular files, traversal components, malformed UTF-8/JSON/JSONL and oversized files are rejected/skipped. Source changes during a read are rejected; immediately before the first object upload every included source file is read again and its original SHA-256 checked against the plan. Keep source writers paused or use an approved frozen copy for a consistent multi-file snapshot; this is not a global filesystem snapshot. Records added after the scan require another migration.

Default bounds: 2 MiB per source file, 32 MiB total source bytes, 10,000 visited source entries, limited known-directory depth. Programmatic scanning limits cannot exceed 32 MiB/file or 128 MiB total, but every final serialized cloud record and manifest must fit the shared 2 MiB cloud upload limit. Planning fails before any write if an envelope exceeds that ceiling. Larger archives need a separately reviewed split/import strategy; raising the scanning bound does not bypass the cloud record limit. JSON nesting over 100 levels is refused. The native safe traversal currently requires Linux `/proc/self/fd`; run it on the dot cloud computer or another authorized Linux migration environment.

## Review, apply, retry

The destination workspace must already exist. Never pass credentials on command-line arguments. PostgreSQL/S3 use the same existing `CODIA_CLOUD_*` environment configuration as the server, with `--backend postgres` explicitly selecting PostgreSQL+S3 and no fallback. Apply `002-workspace-runtime.sql`, then `003-legacy-migration.sql` through the reviewed deployment migration process first. This command does not run schema migrations, create roles, generate credentials, grant access or provision buckets.

Local development example (replace all example paths/IDs with verified values):

```sh
node scripts/migrate-cloud-workspace.mjs \
  --backend sqlite-local --mode dry-run \
  --sqlite /approved/cloud-workspace/metadata.db \
  --workspace-id 12345678-1234-5123-a123-123456789abc \
  --user-id alice --studio-id studio-a \
  --source-root /approved/legacy-copy --source-id desktop-one \
  --agent agent-a --include-shared-state
```

Review `records`, `skipped`, `totalBytes` and `planSha256`. Output contains identity/hash metadata, never conversation bodies. The dry run opens SQLite read-only and creates no migration tables, objects or audit entries; PostgreSQL performs only scoped SELECTs in transactions. An absent destination database is an error.

Apply the same selection with `--mode apply --expected-plan <reviewed-planSha256> --ack-source-ownership`; local mode additionally requires `--objects /approved/cloud-workspace/objects`. A changed plan fails and requires another dry run. A source changed between planning and applying fails before any object write. PostgreSQL mode ignores no local data: it rejects `--sqlite`/`--objects` options rather than silently switching backends.

Objects are written with `putImmutable` and fully read back to verify size and SHA-256 before publishing metadata. A crash or failed commit may leave unreachable immutable objects, but never a partially committed set of imported file pointers. Retry verifies/reuses the same object keys. The import transaction atomically writes file/version metadata, the source-ID map, batch history, file current pointers and an append-only audit entry. It creates no executable jobs or legacy side effects.

The default batch ID is deterministic for the reviewed plan. Repeating an applied plan is a no-op, including after process restart. An existing batch ID with different content is rejected. Modified legacy records create new immutable versions on the same canonical cloud file IDs only while the current cloud head is still the last imported head. A later cloud edit is preserved and blocks a changed-source overwrite. Unchanged source records remain unchanged even if the cloud has subsequently been edited.

## Rollback without deleting history

```sh
node scripts/migrate-cloud-workspace.mjs \
  --backend sqlite-local --mode rollback \
  --sqlite /approved/cloud-workspace/metadata.db \
  --workspace-id 12345678-1234-5123-a123-123456789abc \
  --user-id alice --studio-id studio-a --batch-id <applied-batch-id>
```

Rollback is scoped to the original owner and workspace. Each imported file is reverted only if both its current version and migration mapping still equal that batch's imported version. A later cloud/import write is counted in `preserved` and remains untouched. Updated records regain their prior head; new records become invisible by setting the current head to NULL. Original source files, old versions, object bytes, batch items and audit entries are never deleted. Historical versions remain readable to their authorized owner. A second rollback returns the same recorded result and creates no duplicate audit row.

A rolled-back batch cannot be reapplied under the same ID. To deliberately import again, choose a new `--batch-id <UUID>`, run a new dry run and review its digest. Rollback of a batch with `preserved > 0` is intentionally partial; examine those records rather than forcing a head overwrite. Orphan-object retention/garbage collection is a separate reviewed operation.

## PostgreSQL migration privileges

Migration metadata tables are owner/tenant RLS scoped with `FORCE ROW LEVEL SECURITY`, scoped foreign keys, and immutable audit/item-history triggers. The importer explicitly disables trusted-worker context. The reviewed runtime role needs SELECT/INSERT/UPDATE on `legacy_batches` and `legacy_sources`, and SELECT/INSERT on `legacy_items` and `legacy_audit`, in addition to the existing file/version grants. It needs no DELETE/TRUNCATE, table ownership, BYPASSRLS, role-management or bucket-administration permissions. No grants are executed by `003`.

## Programmatic API and verification

- `scanLegacyData(selection)` reads known source records without changing them
- `planLegacyMigration(actor, workspaceId, scan, repository.migrationSnapshot(...), batchId?)` returns the deterministic plan
- `migrationPlanSummary(plan)` omits payload buffers and absolute source root
- `applyLegacyMigration(repository, privateObjectStore, plan)` verifies source/object integrity and commits through the async port
- `repository.rollbackMigration(actor, workspaceId, batchId)` performs compare-and-set rollback
- `SqliteLegacyMigrationRepository` adapts a local synchronous SQLite transaction without awaiting inside it
- `PostgresLegacyMigrationRepository` uses the real async PostgreSQL transaction adapter

```sh
node scripts/migrate-cloud-workspace.mjs --help
npx vitest run tests/cloud-workspace-migration.test.ts
npx eslint lib/cloud-workspace/*legacy-migration*.ts tests/cloud-workspace-migration.test.ts scripts/migrate-cloud-workspace.mjs
npm run typecheck:node
```

These automated migration tests use synthetic records and verify actual immutable object bytes plus SQLite metadata, dry-run/no mutation, canonical record envelopes, scoped authorization, restart/retry idempotency, source-path/secret filtering, stale source refusal, partial object failure recovery, changed source versioning, preserved newer cloud writes, atomic rollback and immutable audits. A passing local test suite is not evidence that customer records have been imported or that a hosted provider has been configured/deployed.

### Native PostgreSQL evidence

The additional integration test applies the real `002` and `003` SQL to a disposable native PostgreSQL 17.11 database. It uses a separate NOLOGIN, NOSUPERUSER, NOBYPASSRLS test role that does not own the tables, and verifies real metadata/object round trips, source updates, canonical identity, rollback, newer cloud edits, scoped denial, and immutable audit triggers. Synthetic object bytes in this test use `LocalObjectStore`; this is not a live hosted-S3/customer-data migration test.

```sh
# Only against a fresh disposable integration database:
CODIA_TEST_POSTGRES_URL=<disposable-test-database-url> \
  npx vitest run tests/cloud-workspace-migration-postgres.test.ts

# The prepared cloud development helper supplies a unique database/server per run:
bash /workspace/shared/codia-integration-runtime/with-postgres.sh -- \
  npx vitest run tests/cloud-workspace-migration-postgres.test.ts
```

The PostgreSQL test is skipped when that explicit test URL is absent. It intentionally creates the schema and a non-login test role and must never target a customer database. Other integration suites that create `codia_workspace` need separate disposable databases, not a concurrent run against the same test database.
