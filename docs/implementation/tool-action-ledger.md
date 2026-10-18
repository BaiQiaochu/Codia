# Per-tool durable action ledger

Implemented in `lib/tools/tool-action-ledger.ts`, integrated at the shared session permission wrapper and engine tool construction. This extends the workflow agent-node journal to individual wrapped tool calls without creating another approval system.

## Identity and persisted state

- `actionId` hashes the session path and full tool-call ID. Parameters are deliberately excluded from identity: changing parameters under an existing ID is rejected rather than bypassing duplicate detection.
- Separate canonical digests bind tool parameters and execution scope (session, agent, working directory). The same action ID appears in explicit approval cards and automatic approval requests. The record carries the approval decision/confirmation reference and available trace IDs.
- A new record is exclusively created as `planned`, flushed, then atomically replaced and flushed as `running` before the underlying tool executes. Existing write claims cannot execute concurrently, including from another ledger instance/process.
- Positive tool completion becomes `succeeded`. Exceptions, error results and interrupted writes remain `unknown` or `running`. A failure to persist completion returns `ACTION_RESULT_UNKNOWN`.
- Persisted records contain no raw parameters, output, scope paths or exception messages. An opaque session reference enables lookup of a still-existing original session. Files are mode 0600 in a 0700 directory. File contents are fsynced; directory metadata is also fsynced on POSIX. Node does not expose equivalent directory fsync on Windows.

## Retry behavior

- `planned`, `running`, or `unknown` writes return `ACTION_RESULT_UNKNOWN`, with no re-execution. `succeeded` writes return `ACTION_ALREADY_COMPLETED`, also without re-execution. Completed results are not cached or fabricated.
- Parameter/scope changes under an existing identity return `ACTION_BINDING_CHANGED`.
- Only explicitly recognized built-in read tools may retry automatically. Unknown tools, plugins, browser and shell actions are conservatively treated as writes, regardless of permission mode.
- Missing stable session/call identity, corrupted storage, or storage failures fail closed. A ledger is injected by the engine; standalone wrappers without this dependency retain their existing behavior.

## Boundaries and remaining work

This is duplicate suppression for the same stable tool call, not exactly-once delivery to external services. A newly generated model tool-call ID is a new action and is not semantically deduplicated. Recovery must preserve the original call identity. External reconciliation and cancellation annotations remain future work; the module does not mark an uncertain write safe based on a timeout or provide a blind “reset and retry” API. No sensitive result payloads are persisted for replay. Version pinning of whole workflow runtimes is handled separately.

## Verification

`npx vitest run tests/tool-action-ledger.test.ts tests/approval-binding.test.ts tests/session-permission-wrapper.test.ts --maxWorkers=1`

Coverage includes forced child-process death after a simulated external effect, reconstruction of the ledger, concurrent duplicate writes, response timeout, successful duplicate suppression, changed parameters/scope, safe read retry, corruption, unavailable storage, failed completion persistence, approval identity, and absence of raw secrets/results on disk.

## Read-only recovery inspection

`GET /api/tool-actions` and `GET /api/tool-actions/:actionId` expose a strict metadata allowlist under the existing studio-owner route policy. The list is bounded to 100 recent entries and reports unreadable entries explicitly. Parameter digests, parameters, outputs and arbitrary legacy JSON keys are excluded. Session navigation is resolved from the opaque session reference against `engine.listSessions()`; missing/legacy sessions receive no guessed target.

The task console includes an on-demand “工具动作恢复检查” panel displaying actual action states, trace/confirmation references and original-session navigation. Navigation does not retry, cancel or undo an external operation. No mutation, reset, deletion or resubmission endpoint is exposed. This closes safe inspection, not the future externally verified reconciliation/cancellation workflow.

Focused verification additionally covers `tests/tool-actions-route.test.ts`, `desktop/src/react/components/ToolActionLedgerPanel.test.tsx`, and the existing task console component tests (34 passing tests across all six related files).
