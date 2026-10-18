# Artifacts and evaluation workbench

## Registered artifacts and historical content

The task console lists visible registered session files. Preview and export reuse resource-backed file previews and authenticated resource URLs. Missing, expired and directory resources do not expose current-file preview/export/snapshot actions.

On a server reporting secure snapshot support, historical versions contain **saved bytes**, not only registration timestamps or sizes. The user explicitly selects **保存内容快照** for a registered artifact. Merely opening the results panel never creates a snapshot. Each save copies the current authorized regular file, records SHA-256, size, capture time, source file ID, source mtime, monotonically increasing sequence and parent snapshot ID. An unchanged latest version is reused. Later source edits or deletion do not change the saved bytes. Existing files do not retroactively acquire unsaved history.

Snapshots are hidden session-registry entries with a separate `artifact_snapshot` origin/storage kind, outside transient managed-cache watermarking and expiry. Bytes and records are exclusively created, fsynced and read-only; history is recovered from disk after restart. Filesystem owners can still alter local data, so comparison and content delivery re-verify the stored hash and fails closed on tampering rather than claiming filesystem-level immutability. An interrupted save can leave an unlisted copy; that copy still counts toward the quota. It is not silently deleted or exposed as a complete version.

Safety and retention policy:

- Inputs are registered file IDs within the validated existing session. No capture/compare request accepts a caller-supplied filesystem path.
- Session capability checks and existing resource authorization are both enforced. Hidden copies cannot be used as fresh snapshot sources. Comparison accepts only two saved versions of the same source artifact and session.
- Source canonical path, symlink/hardlink status, inode and before/after size/mtime/ctime are checked. On Linux, the opened descriptor's kernel path (`/proc/self/fd`) must match the registered canonical path before any content byte is read and again afterward; pathname checks alone are insufficient against transient ancestor swaps. New snapshot files are opened relative to a verified directory descriptor. Source files that change during capture are rejected. Reads are bounded before allocation.
- Storage directories, metadata and payload reads reject symlinks and escaping paths. Metadata IDs/extensions are validated. Existing resource routes apply resource authorization plus snapshot session ownership/capability checks, then hash-verify bounded bytes and serve that exact buffer (including range/HEAD/ETag handling). They never reopen the snapshot path after verification. Resource tickets are issued only after these checks and remain restricted to their signed resource ID.
- Limits are 5 MiB per captured file, 10 versions per artifact, and 50 snapshots / 50 MiB payload bytes per session. Orphaned payloads also count. Reaching a limit **refuses new saves**; it never evicts old versions or deletes original files. This release does not add an automatic history deletion mechanism.
- Snapshot history is local; it is not a backup/remote sync service or a guarantee of survival after local data loss.

### Platform support and metadata trust

`GET /api/task-artifacts` returns `capabilities: { platform, snapshotAvailable, reason }`.
Secure snapshot capture, historical-content preview/export, and comparison currently
require Linux with a usable `/proc/self/fd` handle mapping. Windows and macOS return
`snapshot_platform_unsupported`; Linux without usable procfs returns
`snapshot_fd_verification_unavailable`. Content operations fail closed with HTTP 503.
The UI disables these actions (also for older servers without capabilities) and
explains the platform limitation. Ordinary registered-file preview/export is unchanged.

The existing Windows sandbox helper does use `GetFinalPathNameByHandleW` internally,
but it closes its own handle and does not expose an API that validates the same
handle Node uses to read snapshot bytes. Reopening a pathname after that check would
reintroduce the race. A future Windows/macOS implementation needs a same-handle
native read/create interface and platform regression tests; those platforms have
not been certified for secure content snapshots in this change.

Historical metadata remains visible even when content snapshots are unavailable.
Metadata reads are limited to 4 KiB per record, reject ordinary symlinks/hardlinks,
validate the expected object schema, IDs, hash shape, timestamps and bounded labels,
and rebuild a strict field allowlist. Session/source/copy ownership and existing
resource permissions still apply. On unsupported platforms these records are
**untrusted historical metadata, not evidence that the stored bytes or hash have
been verified**. This metadata-only fallback is never used for source or payload
reads. Filesystem owners can rewrite both metadata and payloads; this is not an
append-only authenticated storage system or protection from an administrator.

Comparison shows an actual line-level UTF-8 diff for up to 64 KiB and 300 lines per version. React renders content as text, including HTML-like strings. Blank lines and carriage returns are marked, so line-ending changes remain visible. Binary/non-UTF-8 input or larger text receives a clearly labeled byte-hash/size comparison. This is not semantic Word/PDF/spreadsheet diff.

## Evaluation reports

The evaluation tab reads local JSON reports from scripts/evaluation-gate.mjs, validates the schema, strips non-summary fields, compares case outcomes, flags missing prior cases as regressions and exports a local summary. It does not upload reports or execute commands/models. The 30-case gate is deterministic reliability validation, not a real-model task-quality or cost benchmark. The report records source revision and dirty-worktree state, so an uncommitted run is not represented as a clean released revision.

The workbench also accepts the separate [bounded model-task benchmark](model-task-evaluation.md) reports, with explicit disabled/mock/live provenance, versioned datasets, compatible baseline comparison and unknown-cost coverage. Offline reference replay never counts as live model acceptance.
