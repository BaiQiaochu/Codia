# Capability-scoped cloud Agent tasks and durable schedules

This stage extends the existing Codia desktop/mobile Cloud Workspace and the existing PostgreSQL/S3 or SQLite/local-object authority. It does not replace the original project, deploy a public service, provision an account or credential, call a paid provider during verification, or migrate every legacy host tool.

## User flow

1. Open Cloud Workspace and select an existing workspace.
2. Create an immutable task plan with a title, instruction and up to eight selected text file versions. A saved workflow draft can supply its exact saved instruction/version. Creating a plan does not run it.
3. With an actor-authorized configured AI model, start the task. The normal durable worker executes independently of the renderer. Reopen the workspace on another authorized client to see progress and the result.
4. The completed task shows its final response, sanitized tool transcript and text artifacts. These are one immutable, integrity-verified session bundle. Artifact contents are displayed as text, never executed HTML.
5. A schedule can target the exact task-plan version, or a pinned document version for fixed processing/AI summary. Creation defaults to paused. Enabling explicitly allows future occurrences. Pausing stops future enqueueing; use Cancel on an already queued/running task to stop that attempt.

The fixed document transform remains usable without AI configuration. AI start and schedule enable require both file-write and chat capability plus that actor's configured model. A files-only client may save an inert plan/paused schedule but cannot enable paid invocation. Other accounts cannot borrow the existing Codia engine owner's key.

## Honest legacy bridge

The original Pi Agent SDK is reused with a capability-scoped cloud tool set. The cloud worker never invokes the legacy host `executeIsolated` path, loads a user's legacy plugin registry, replays arbitrary workflow JavaScript, launches shells, or reads local session directories from a model-supplied path.

A saved cloud workflow draft can be explicitly converted to a task plan. The exact `data.instruction` and selected cloud file versions are used; arbitrary steps, legacy execution settings, local file paths, prior enabled/running status, scripts and embedded credentials are not transferred into execution authority. Editing the draft later does not change an existing plan or schedule.

Imported legacy cron records remain inert historical snapshots. Review their prompt and intended timing, create a new bounded task plan, choose its cloud inputs and new UTC schedule, and explicitly enable it. Cron expressions, local-wall-clock/DST recurrence, legacy host tools, notification delivery and external side effects are deliberately not inferred or migrated. The legacy local scheduler and old local tool chat remain available on their original paths; this stage adds a real cloud execution path for the safe subset rather than claiming complete cutover.

## Tool and process boundary

A trusted fixed child process receives only one actor-bound model credential over stdin plus explicitly authorized immutable text snapshots. The parent resolves every selected version under authenticated owner/studio AND the exact workspace, checks readiness/hash/length, decodes UTF-8 and caps combined input to 128 KiB including the instruction. Task instructions are at most 16,000 characters. Model input never accepts a filesystem path, object-store key or actor identifier from a tool argument.

Only these tools are exposed:

- `list_cloud_files`: metadata of the selected versions
- `read_cloud_file`: exact selected version text; an unknown or unselected ID is rejected
- `create_artifact`: a new in-memory UTF-8 text artifact, with no external side effect

Artifacts are limited to eight, 64 KiB each and 256 KiB total. Names reject paths/control characters and duplicate names with different content. Model execution is bounded to twelve requests, twenty-four tool calls, an approximately 768 KiB transcript-context check, 180 seconds, 256 MiB Node old-space and a 1.5 MiB serialized session. Output validation independently checks run/attempt/input provenance, permitted trace tool names, artifact bounds and SHA-256 before storage. Oversized/malformed results fail closed and publish no partial artifact.

The child has a private temporary HOME, a stripped environment and Node filesystem permissions restricted to installed dependencies. No host shell, network-fetch tool, MCP, plugin, child-process or arbitrary-code tool is exposed. The configured model protocol itself necessarily uses network access. This is a capability-limited trusted program under process/Node limits, **not an OS sandbox for hostile executable code**.

## Durable execution, cancellation and replay

Task plans are immutable input snapshots, and the run pins the exact plan version. Selected input versions and optional workflow provenance are retained in the completed session. The worker's successful session, artifact contents, metadata pointer, run state and outbox event become visible only after the existing fenced completion transaction. An object uploaded before a failed/stale commit can remain an unreachable immutable orphan; it is never promoted into a partial user-visible result.

Lease renewal checks cancellation every second while an executor is active, and checks again immediately before staging output. Completion independently checks current run status, attempt and unexpired lease. Cancellation is actor-scoped, idempotent and terminal-race safe: a queued/running run becomes `status=failed,error=cancelled` with a `run.cancelled` event; success already committed is not undone. Stale executors cannot revive a cancelled run or commit output.

The successful final session persists user/assistant text, allowed tool calls/results and artifact bytes. Model reasoning content, provider headers, keys and raw provider errors are excluded. Failed/cancelled attempts retain durable status/error/events but no partial tool transcript or artifact. Recovery restarts a pinned attempt from its input; it does not replay an incomplete transcript. The tools have no externally committed side effects before success, making this restart safe for the supported subset.

Visible durable completion is at most once per run. Provider calls remain at least once: a crash after an API call but before commit can repeat a paid call; a stable SDK session ID does not guarantee billing idempotency. This risk is disclosed when enabling AI schedules. Maximum reclaimed run attempts remains three.

## Schedule semantics

- The database stores absolute UTC epoch milliseconds, not client timezone strings. UI local date/time entry is converted explicitly; the resulting UTC time is displayed. There is no cron-expression or DST-wall-clock recurrence engine in this cloud scheduler.
- One-time schedules complete after enqueueing their single occurrence. Completion here means occurrence dispatch; inspect the linked run for execution success/failure.
- Interval schedules are bounded to 60 seconds through 366 days. Each schedule pins immutable operation/input versions and creation parameters.
- Due enqueue, schedule advance, revision and outbox event commit in one transaction. The occurrence request key is `schedule_<id>_<due-time>`, reserved from public run creation. Concurrent dispatchers/restarts cannot create duplicate runs for one occurrence.
- Missed intervals coalesce into one due occurrence and advance to the first future interval. There is no burst catch-up after server downtime.
- If the preceding schedule run remains queued/running, the due occurrence is skipped and time advances, with `schedule.skipped` and its overlap reason. There is no overlapping run for the same schedule.
- Pause/resume uses an optimistic revision. A stale client receives a conflict and must refresh. Resume of an overdue recurring schedule follows the same coalescing rule. A completed one-time schedule cannot be re-enabled; explicitly create a new schedule.
- Schedule rows are authorized by user and studio, with PostgreSQL FORCE RLS and scoped foreign keys. Tenant identities and worker scope are resolved server-side. Runtime database access is still a trusted service capability, not browser authority.

## Upgrade and rollback

Apply `004-cloud-agent-tasks.sql` explicitly after schema 002 (003 remains required for legacy importer support) with the existing reviewed migration identity, then deploy matching server/UI code. Runtime schema verification requires version 4. Existing workspace/file/version/run/event rows are preserved; only the operation constraint expands and the new schedule table is added. The SQLite development adapter creates the new table in its existing database without copying or resetting data.

See `lib/cloud-workspace/migrations/README.md` for grants and operational details. Migration files do not create roles, secrets or new security permissions themselves. The reviewed runtime role needs SELECT/INSERT/UPDATE on schedules, not deletion, role ownership or BYPASSRLS.

For operational rollback, stop matching workers, pause new schedules and retain a matching metadata/object backup. Do not drop the schedule table, delete session bundles or narrow the operation constraint while agent-task history exists. Old code cannot safely consume every new operation; use the matching server version to retain history or a reviewed restore of the matched backup. No automatic destructive down migration or secret change is performed.

## Verification

- `tests/cloud-agent-tasks.test.ts`: actual Pi SDK child plus loopback synthetic HTTP model protocol; multi-turn list/read/create/final; old pinned input after newer edit; full result/reopen; blocked unselected file/legacy tool/path names; cancellation after in-memory artifact creation; bounded infinite tool loop; invalid child output; tenant/workspace denial; inert workflow conversion; API scope enforcement.
- `tests/cloud-schedules*.test.ts`: SQLite restart, idempotency, pause/resume conflicts, coalescing, overlap, cancellation and native PostgreSQL concurrency/RLS/upgrade checks.
- Existing cloud records/storage/migration and desktop regressions remain applicable. The final delivery index gives exact final commands/results, including native compiled-app screenshots.

Synthetic model fixtures prove the protocol/tool/durability path, not real-provider quality. A local native PostgreSQL or HTTPS S3 contract fixture does not establish a deployed managed cloud service. No production deployment or real-model paid-call result is claimed.
