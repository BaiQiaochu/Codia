# Script workflow reliability slice

## Behavior

- `parallel(thunks, { failurePolicy: "fail-fast" })` is the default. A branch error rejects the step and aborts this host's agent signal. Queued agent work and subsequent pipeline stages check cancellation before dispatch.
- `parallel(thunks, { failurePolicy: "collect-errors" })` waits for independent branches and throws an `AggregateError`. Its `results` array contains index-aligned fulfilled values or rejected reasons. Completed artifacts are retained; failure never becomes `null` success.
- `pipeline(items, ...stages, { failurePolicy: "collect-errors" })` accepts the same optional trailing policy. Failed items stop their own subsequent stages.
- Catching a helper failure for diagnostic purposes does not turn the overall run into a successful run. The sandbox checks the runtime contract before returning success.
- Cancellation is cooperative: an already-dispatched external operation may finish despite abort. Its outcome is conservatively journaled as unknown if completion cannot be confirmed.

## Runtime budgets

Optional `args.maxSteps` (integer 1–1000), `args.maxDurationMs` (integer 1–600000), and `args.budgetTokens` (positive integer) bound a run. Nested hosts share dispatch and wall-clock budgets. Step limits are consumed only on actual agent dispatch, and duration is checked before dispatch and between pipeline stages. Sandbox deadlines abort in-flight agent signals cooperatively. Limits are included in the immutable argument snapshot. In-flight provider usage may exceed a token estimate; there is no USD billing hard cap for these ordinary workflow arguments.

Checkpoint recovery is disabled for any workflow with an explicit, non-null `budgetTokens`, `maxSteps`, or `maxDurationMs`, including one that finished below its limit. Existing journals do not contain enough durable cumulative token, step, and elapsed-time accounting to restore the original allowance safely. Issuing a new task ID would otherwise reset those limits, and a missing ledger after restart could falsely report zero spending. Both the tool and the recovery inspection/draft endpoints fail closed before creating a recovery claim or dispatching any agent. Removing or increasing arguments cannot bypass the original definition check. Inspect prior usage and external effects before separately reviewing a new run and its budget; a new run is not an automatic continuation and must not blindly repeat writes. Ordinary checkpoint replay without explicit limits remains available under the other recovery checks.

## Recovery safety

The existing JSONL journal is retained. Agent dispatch is durably appended and fsynced before execution; confirmation is persisted before a successful event. Entries include stable action IDs and existing workflow thread IDs. Write-capable or unspecified-access agents are treated as potentially side-effecting. A failed/interrupted write is `unknown` and cannot automatically replay. Explicit read-only actions can retry.

Each run stores the exact submitted definition and an immutable digest of the script, arguments, agent identity, execution directory, parent session and runtime contract version. Resume rejects incompatible or legacy unversioned journals. Malformed journals fail closed. Successful checkpoints are inherited by recovery attempts, including checkpoints not visited before a later failure. Nested workflows share a sequence allocator to avoid journal/thread ID collisions.

A durable single-successor claim prevents reusing the same recovery checkpoint concurrently or repeatedly. Continue from the latest recovery run rather than its predecessor. Recovery also blocks while an unfinished source run's recorded process may still be alive. PID reuse conservatively blocks rather than risking duplicate work. A crash while acquiring or initializing a recovery claim may require manual inspection; no automatic stale-claim removal is provided.

## Deliberate limits

This is an agent-node safety boundary, not a per-tool transactional engine. The script runtime delegates tools through existing session permission and approval mechanisms; no second approval service is introduced. Production runs now pin the local implementation/dependency digest and registry snapshot (resolved model definitions, agent configuration, prompts and tool definitions) in the immutable run key. Every node additionally passes an execution gate after the real isolated session has resolved its final model, system prompt and tools, before any model request. Its snapshot is fsynced with the running checkpoint. Recovery validates this snapshot even for cached successful writes; it does not invoke the model or tools to replay them. Registry drift is checked before each node and again at the execution gate. Missing/legacy snapshots and external Wukong execution are blocked. Only digests are persisted, never raw configuration or prompt secrets.

This pins local software/configuration, not an external provider's mutable model alias or an MCP server's undisclosed backend implementation. Registered schemas/configuration changes are detected; server-side behavior without a published immutable version cannot be guaranteed. Strict prompt/config matching can also block recovery after legitimate memory or environment updates. Inspect the completed effects and start a separately reviewed run rather than weakening the invariant. The implementation digest uses the existing CODIA_ROOT-aware application resolver: source checkouts hash runtime sources, while official bundled distributions hash the executing bundle/chunks and shipped runtime assets plus their installed dependency lock. Contents are re-read to detect in-process file changes. Missing version evidence blocks execution. The task console shows checkpoint actions and blockers, opens the original session for external-result inspection, and prepares an exact-version recovery draft in that session for review. Unknown writes cannot prepare a recovery draft. A separately confirmed abandon-checkpoint action disables later recovery; it does not undo external effects or stop an already-created successor. No override silently authorizes another write. Existing saved journals without a version snapshot cannot safely auto-resume. There is no exactly-once guarantee for services lacking idempotency.

## Verification

- Before the fix, the two regression tests reproduced `parallel` resolving `['ok', null]` and `pipeline` resolving `[null]` after errors.
- `npx vitest run tests/workflow-*.test.ts desktop/src/react/components/WorkflowRecoveryPanel.test.tsx desktop/src/react/components/TaskConsolePanel.test.tsx`: 17 files, 105 tests passing.
- Tests cover external-write success followed by client timeout, crash-left running writes, read-only retry, persistence failure before dispatch, immutable metadata, corrupt journals, cancellation, partial result retention, nested IDs, unchanged successful replay, changed-definition rejection, concurrent recovery claims and live-source guards.
- `tests/workflow-budget-recovery.test.ts` covers token/step exhaustion followed by recovery, missing usage ledger after restart, removed/increased arguments, duration limits, matching API/UI blockers, and refusing recovery without consuming a claim.
- Deterministic mocks validate orchestration and persistence. File append and a local HTTP upload service are exercised with simulated loss of client confirmation, and each remains written exactly once after attempted recovery. Real-provider kill/restart and production external-service acceptance remain deployment validation work.

## Bounded template cancellation and recovery

The existing workflow tool now exposes an owner-only live-run cancellation handle. `/workflow-runs/:runId/cancel` aborts its shared signal and stops later node dispatch; completed or uncertain external effects are not undone. This is separate from abandoning a saved recovery checkpoint.

Budgeted templates carry a trusted shared RunBudget through nested orchestration into each actual isolated SDK stream. Model/tool choices cannot widen the trusted context; SDK compaction/retry and out-of-budget delegation are disabled. Reserve/settle evidence is written through the activity hub. Restart marks budget evidence unknown after the last checkpoint. The original budget contract is hashed into recovery compatibility, and generic draft recovery is disabled for these runs, preventing an unbounded replay. A new reviewed budget requires inspection of prior usage and side effects.
