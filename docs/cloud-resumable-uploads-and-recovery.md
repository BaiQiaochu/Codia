# Bounded resumable cloud uploads and explicit run recovery

This increment extends the existing Codia desktop/mobile Cloud Workspace. The
source baseline is `08d15d339ec715a7dbb023fadb6887270ba21873` on `zjh`, incorporating
upstream `main` at `0c1181495ae35fb149a745a90bc47137c464bfb6`. It does not deploy a
hosted service, grant cloud permissions, create credentials, or change the legacy
local agent/tool engine.

## Storage and execution are separate limits

- New resumable uploads accept **32 MiB** (33,554,432 bytes), including arbitrary
  binary bytes and empty files. The old JSON/base64 endpoints retain their
  **2 MiB** contract for older clients and ResourceIO callers.
- Each resumable request carries one exact **1 MiB** raw binary chunk, except the
  shorter last chunk. No chunk is base64 expanded. Empty files have zero chunks.
- Document checking/summary remains capped at **2 MiB** UTF-8. AI summary and
  selected task inputs remain bounded to **128 KiB**, with the existing aggregate
  task/instruction limit. Saving a larger file does not make it eligible for an
  executor. Such files remain available as immutable versions for download.
- Preview reads remain bounded. Binary/oversize input is never rendered as HTML,
  interpreted as code, or automatically sent to a model.

Final assembly is bounded but **buffered**, and local/S3 adapters also buffer
objects. This is resumable application-level chunk transfer, not unbounded
streaming, native S3 multipart upload, direct-to-bucket browser access, or a
32 MiB total-process-memory guarantee. Account quotas and process admission
limits complement the per-request byte limits; production request-rate, storage,
and process-memory controls remain deployment responsibilities.

## API and identity

All paths below are relative to `/api/cloud` and use the authenticated owner and
studio derived from the existing server principal. Client JSON cannot select an
actor, tenant, object key or host path. Existing file-read/file-write capabilities,
mutation request headers and exact-origin policy apply to the new routes.

- `POST /workspaces/:id/uploads`: `{name,size,sha256,requestKey,fileId?,expectedVersion?}`
- `GET /workspaces/:id/uploads`: authorized resumable upload sessions
- `GET /uploads/:id`: one authorized session and received chunk indexes
- `PUT /uploads/:id/chunks/:index`: `application/octet-stream`,
  `X-Chunk-SHA256`, and `X-Requested-With: cloud-studio`
- `POST /uploads/:id/complete`: `{}`
- `POST /uploads/:id/cancel`: `{}`
- `POST /runs/:id/retry`: `{requestKey}`

Session reads return safe logical identifiers, size/hash, state, revision,
expiry, received indexes/bytes and the reserved file/version identity. They never
return object-store keys or credentials. A replacement session pins both target
file and expected current version. Both values are rechecked at publication;
completion cannot silently overwrite a newer version created by another client.

Creating a session with the same request key and exact original specification
returns that session, including after its terminal outcome. Reusing the key for
a changed payload is a conflict. Chunks are length-checked, hash-checked, indexed
and immutable. Identical retransmission is allowed; changed bytes at the same
index are rejected. Completion requires every expected chunk and freezes an
ordered, SHA-256-identified manifest. Full assembled length/hash and persisted
object integrity are independently checked before the file becomes visible.

## Interruption, restart and cancellation

The database and object store hold acknowledged chunks. Stopping the renderer,
closing the tab or aborting a network request does not undo an already committed
chunk or completed version. On refresh the client reads the server's session
state and retransmits only missing chunks. If browser file memory was lost, the
user must select the original file again. Its complete SHA-256 and size must match
the session; a matching filename and size alone are insufficient. The application
does not persist raw local file bytes or local host paths in browser storage.

The pause action aborts the client's transfer while retaining the session. The
cancel action requests a durable server terminal state. Cancel and final publish
serialize: an already completed file remains completed; a cancel that commits
first prevents a later publish. An uncertain network response is reconciled by
reading that same session, not by manufacturing another upload/version. Repeated
completion returns the original committed version. Repeated cancellation is
idempotent. Stale general staging cleanup excludes active upload session versions.

An owner/studio is limited to eight active sessions and 128 MiB of active declared
bytes across all workspaces. A separate rolling 24-hour budget allows 32 sessions
and 512 MiB of declared bytes across every state. Cancelling/completing a transfer
does not refund that retained budget, preventing rapid cancel/recreate loops from
bypassing it. Buffered finalization admits at most two concurrent sessions per
server process; excess requests receive retryable `upload_completion_busy` (503).
Same-session requests join a single authorized in-process operation, while
database fencing covers different processes and restarts.

Sessions expire 24 hours after creation. Expired/cancelled sessions cannot be
resumed; select the file for a new session. Expiry releases active work without
publishing a partial file. Existing ready versions and historical run artifacts
are unaffected.

## Temporary object retention and deployment limits

Temporary chunks are stored under the server-generated prefix
`workspaces/<workspace-id>/uploads/<upload-id>/chunks/`. Published file versions
use the separate immutable file-version prefix. Cancelling or expiring a session
invalidates its authority; it is not a claim that every stored byte was erased.

This increment does not provision or silently change a bucket lifecycle, grant
DeleteObject, delete historical metadata, or install a destructive production
collector. Before hosted use, operators must review a temporary-prefix lifecycle
with a retention grace longer than the 24-hour upload window and maximum in-flight
request duration. Never apply that policy to final file versions or run artifacts.
Local development object names are key-hashed envelopes, so filesystem mtime alone
is insufficient to safely identify collectible objects. Retain matched metadata
and object backups; use a separately reviewed metadata-aware collector for local
cleanup. Orphaned final objects from failed CAS/fenced completion are likewise
unreachable rather than automatically deleted. Quotas limit concurrent/reserved
work; they are not total historical storage accounting or a production GC system.

## Explicit retry is a new linked run

Only failed runs, including durable `error=cancelled`, can be explicitly retried.
Active or successful runs are rejected. Generic recovery does not reopen
`agent-conversation`, whose transcript/version concurrency belongs to the record
message flow. The new run keeps the source operation and exact input version,
links back through `retry_of`, starts its own attempt counter, and leaves the
source status, events and artifacts intact. Later edits to the file/plan do not
change the retry input. Scope, ownership and applicable model availability are
rechecked before enqueue.

The same retry request key returns the same new run after a lost response. An
explicit subsequent retry request is another run, not a continuation of the
interrupted model token stream or unpublished tool transcript. The UI discloses
that an AI retry can call the configured provider again and incur additional
charges. Existing automatic lease recovery remains at most three attempts per
run; it and explicit retry do not provide exactly-once provider billing.

Durable cancellation is checked by the worker lease heartbeat and again before
artifact publication. The fixed document child now receives an AbortSignal,
is killed on cancellation, and its temporary directory is removed after process
close. Old queued oversized work fails with a specific processing-limit error
before downloading a large stored object. The final transaction still fences
run identity, attempt and lease; cancellation cannot be reversed by a late child.

## Upgrade and compatibility

Apply `005-resumable-uploads.sql` after runtime migrations `002` and `004`
using the existing reviewed migration identity. Migration `003` remains required
only when using the legacy migration tool. PostgreSQL startup requires schema
version 5; the runtime never applies migrations, grants privileges, or falls back
to local storage if the remote schema is missing. New session/chunk tables enforce
owner/studio scope and FORCE RLS. Use the migration README for exact table grants.

SQLite upgrades its existing database on open while preserving workspaces,
versions, events, schedules and old runs. Existing ready-version URLs, legacy
uploads, processing contracts and stored schedule specifications remain intact.
Do not run an older write-capable server against active resumable sessions or
remove new schema/rows to roll back. Stop workers, finish/cancel pending transfers,
retain a matched backup, and use reviewed deployment rollback procedures.

## Verification boundary

Focused tests cover chunk size/hash/order, duplicate and uncertain outcomes,
restart/resume, CAS/cancel races, owner/studio isolation, quota/expiry, processing
limits, explicit retry lineage, old-schema preservation and UI interruption.
Native PostgreSQL tests use an isolated disposable loopback database and a
non-superuser/non-BYPASSRLS role. S3 contract checks use a synthetic HTTPS server
with independently checked signatures; they are not validation against AWS or
another managed storage provider. No paid model calls or production provisioning
are required. Final delivery evidence records the exact commands, checks,
remaining full-suite limitations and genuine compiled-desktop screenshots.
