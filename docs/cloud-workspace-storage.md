> Historical phase-one checkpoint. Current implementation and limits: [cloud-workspace-v2.md](cloud-workspace-v2.md). The remainder records the earlier release.

# Cloud workspace storage adapters

## What exists and what is not integrated

This increment adds real storage implementation code inside the existing Codia project:

- `LocalObjectStore`: local immutable bytes with persisted SHA-256 metadata
- `S3ObjectStore`: HTTPS S3 REST requests authenticated with AWS Signature V4
- `PostgresWorkspaceDatabase`: a real transaction boundary accepting a pg-compatible pool
- `001-cloud-workspaces.sql`: a standalone PostgreSQL target schema with tenant/owner RLS

The running workspace metadata repository in this increment is SQLite. PostgreSQL is **not wired into the HTTP repository or selected by an environment variable**. The PostgreSQL transaction adapter does not implement the repository's CRUD, idempotency, run processing, event replay, or outbox operations. The migration has not been applied to a live PostgreSQL server. S3 requires explicit server-side adapter injection and is not automatically activated by this code. No cloud bucket, project, account, credentials, IAM policy, or security setting was created or changed. Contract tests use fake S3 HTTP transport and fake pg clients; they do not prove a live provider deployment works.

## Object storage contract

Both stores implement:

```ts
interface ObjectStore {
  readonly kind: string;
  putImmutable(key: string, bytes: Buffer): Promise<{ size: number; sha256: string }>;
  get(key: string): Promise<Buffer>;
}
```

Keys are relative logical identifiers, not disk paths or pre-encoded URLs. Empty segments, dot traversal, backslashes, control characters, non-NFC Unicode and malformed Unicode are rejected. UTF-8 length is limited to 1,024 bytes. Generate unique tenant/workspace/file/version-scoped keys on the server after authorization; an object store alone is not an authorization boundary. Verify the returned hash/size against the independently stored, authorized file-version metadata before delivering bytes. Do not let clients select arbitrary stored object keys.

### Local mode

Construct `new LocalObjectStore(rootDir)`. Objects use a SHA-256 key-derived filename and one checksum-and-size envelope. Writes use an exclusive private temporary file, fsync, atomic hard-link publication (never overwrite), and directory fsync. Readers verify the complete envelope and body hash. Reusing a key, even with identical bytes, returns `OBJECT_EXISTS`; retries should be resolved through the metadata/idempotency layer. Readers reject leaf symlinks. Keep the configured root and its ancestors controlled by the service user; this is not isolation against a malicious process with write access to that filesystem. The implementation targets the POSIX cloud runtime and requires same-filesystem hard links and directory fsync. Local storage needs its own backup and recovery plan and is not remotely replicated.

### S3 mode

Inject a server-only configuration into `new S3ObjectStore(...)`:

```ts
const objects = new S3ObjectStore({
  endpoint: configuredHttpsOrigin,
  bucket: configuredBucket,
  region: configuredRegion,
  accessKeyId: suppliedCredentials.accessKeyId,
  secretAccessKey: suppliedCredentials.secretAccessKey,
  sessionToken: suppliedCredentials.sessionToken,
});
```

No adapter credential discovery or `.env` loading occurs. Do not put configuration in the renderer, log signed headers/canonical requests, or commit credentials. Obtain/inject credentials using the deployment's approved secret mechanism. This code does not request, create, rotate, or persist credentials. A fresh adapter must be supplied after expiring credentials rotate.

Only HTTPS origin endpoints and path-style general-purpose buckets are supported. Keys are UTF-8 percent-encoded once, with AWS's extra escaping and preserved logical separators. Redirects are rejected so signed requests cannot be forwarded to another host. The default and maximum timeout is 15 seconds. The implementation uses single PUTs and buffers whole objects; it does not implement multipart upload, streaming, directory buckets, virtual-host-only endpoints, access-point ARNs, presigned URLs, credential refresh, or automatic retry.

PUT signs `If-None-Match: *`, the payload SHA-256, checksum SHA-256, and SHA-256 metadata. A 412 becomes `OBJECT_EXISTS`; 409 becomes `WRITE_CONFLICT`, with no unconditional overwrite fallback. A returned upload checksum is checked when supplied. GET requests checksum reporting, requires the adapter's matching SHA-256 metadata, and verifies any returned SHA-256 checksum. Imported objects without that metadata are rejected. A provider must support conditional PUT and checksum validation; contract tests cannot establish that a particular S3-compatible service correctly enforces either. [AWS documents conditional PUT and checksums](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).

Immutability here is an application write contract, not S3 Object Lock or a guarantee against administrators/other credentials replacing bytes. Use tightly scoped preexisting runtime access (only required GetObject/PutObject prefixes), provider-side conditional-write enforcement, versioning/retention and backup policies after review. Do not grant delete, ACL, bucket administration, or public access for this adapter. [AWS's signing requirements](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html) define the canonical header, path and signing-key behavior.

## PostgreSQL integration boundary

Supply an existing configured pg-compatible pool implementing `PgPool`; no `pg` dependency is installed by this increment. `transaction({ tenantId, actorId }, work)` checks out one client, begins a transaction, sets a restricted local search path, and sets both actor and tenant with parameterized `set_config(..., true)`. This has SET LOCAL lifetime, so COMMIT/ROLLBACK clears request context before pool reuse. All callback SQL must use schema-qualified table names. Await every query; do not retain the callback connection, issue transaction control, or alter context inside it. Only trusted server code may call this boundary.

The authenticated server must derive tenant/actor from a verified session, never request JSON, arbitrary headers or SQL from a user. These settings and RLS are defense in depth for trusted server queries; they do not make an unrestricted SQL connection safe for a client, since such a client could change the settings. Use parameterized values in every repository query. Failed callback/setup/commit causes rollback; failed rollback or failed BEGIN discards the client. The adapter does not automatically retry a transaction because retrying unknown commit outcomes could repeat external side effects.

### Target schema and deployment roles

The migration includes workspaces, files, immutable file versions, runs, immutable run events and transactional outbox entries. All tenant-owned parent/child foreign keys include tenant and owner. File current-version references are deferred to commit; idempotency keys and run-event sequences have scoped uniqueness. The initial RLS policy is owner-only within a tenant. Team membership, shared workspaces, search, retention/purge and global background-worker policies are not implemented.

Apply the migration once through a reviewed migration process on a disposable test database first. Its schema/object creation should be recorded by the deployment's migration runner. It deliberately fails on existing tables rather than silently ignoring a partial deployment. The migration creates no login/role and grants no runtime access.

Use a separate runtime login role that is not a superuser, does not have BYPASSRLS, is not a schema/table owner, has no role membership permitting escalation, and cannot create/alter policies or functions. FORCE ROW LEVEL SECURITY protects ordinary owners during data access, but superusers/BYPASSRLS still bypass it and owners can change policies. [PostgreSQL RLS documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) describes these boundaries.

After the role has been provisioned and reviewed, its minimum grants for the future repository would be schema USAGE; SELECT/INSERT/UPDATE on workspaces, files, runs and outbox; SELECT/INSERT on file_versions and run_events. It should have no DELETE or TRUNCATE grants. No sequence grants are needed: IDs are supplied UUIDs and event/version counters are scoped data values. The migration revokes PUBLIC schema/table/function privileges; verify default privileges and inherited role grants separately. Application transactions must atomically update run state, append the next event and enqueue the matching outbox row. A tenant-scoped worker can claim entries with row locks/SKIP LOCKED inside the same context; a cross-tenant worker requires a separately designed and reviewed dispatch mechanism. None is provisioned here.

### Required live verification before enabling PostgreSQL/S3

1. Implement the PostgreSQL repository and provider selection, keeping existing API semantics and identity derivation
2. Apply the migration to a disposable real PostgreSQL instance; test the exact runtime role with no context, owner A, same-tenant owner B and cross-tenant owner C, including insert/update checks and invalid cross-owner foreign keys
3. Test commit/rollback context reset with a real reused pool connection and verify the runtime role has no bypass/ownership path
4. Against an approved isolated bucket/prefix, verify round-trip checksums, concurrent conditional uploads, 412/409 handling, region/endpoint configuration, expired credentials and network failure behavior
5. Test atomic metadata/history/outbox processing, reconnect event replay, worker delivery/retry, backups/restore and reconciliation for uploaded objects whose metadata transaction failed
6. Only then switch the production repository/provider through reviewed deployment configuration

## Verification commands

```sh
npx vitest run tests/cloud-storage-adapters.test.ts
npx eslint lib/cloud-workspace/object-store.ts lib/cloud-workspace/postgres.ts tests/cloud-storage-adapters.test.ts
```

Tests cover the deterministic signature vector/canonical request, URL encoding, signed conditional writes, checksum mismatch, error redaction, local immutable publication, local corruption detection, unsafe keys, transaction-local context, rollback/discard, context capture, inactive handles, and static schema/RLS invariants. SQL source-contract checks are not PostgreSQL execution tests.
