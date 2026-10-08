# openhanako 0.341.19 final migration report

Date: 2026-06-22
Source: `E:\G-sap\openhanako-0.341.19`
Baseline source: `E:\G-sap\openhanako-0.341.13`
Compare reference: `https://github.com/liliMozi/openhanako/compare/v0.341.13...v0.341.19`

## Final Status

The 0.341.19 migration scope has been rechecked against the local original source and the main program.

Final result: complete for the 0.341.13 -> 0.341.19 functional delta.

## Source Delta Checked

The original delta was concentrated in these runtime areas:

- Deferred result notification and delivery records.
- Turn input presentation / consumption records.
- Chat history reconstruction and live stream buffering for deferred image/video results.
- Workflow host API validation and workflow node lifecycle.
- Bridge owner session active-tool filtering.

The local source diff also changed tests around these areas:

- `tests/deferred-result-coordinator.test.ts`
- `tests/message-utils.test.ts`
- `tests/session-coordinator-deferred-delivery.test.ts`
- `tests/workflow-host-api.test.ts`
- `tests/workflow-integration.test.ts`
- `tests/workflow-tool.test.ts`
- `desktop/src/react/__tests__/hooks/use-stream-buffer.test.ts`
- `desktop/src/react/__tests__/stores/chat-slice.test.ts`
- `desktop/src/react/__tests__/utils/history-builder.test.ts`

## Migrated / Verified Items

### Deferred Result Lifecycle

- G-SAP emits debranded `gsap-background-result` hidden messages and `gsap-deferred-result` records.
- Hidden result messages include `details.schemaVersion`, `details.taskId`, and stable `details.deliveryId`.
- Legacy `hana-background-result` markup is accepted for compatibility, but new emissions remain debranded.
- UI-only image/video results are stored as non-context custom entries instead of waking the parent agent.
- Bridge-targeted deferred results are not consumed by the desktop UI-only path.

### Additional Gap Found And Fixed In This Pass

The recheck found one real migration gap from the original 0.341.19 logic:

- UI-only failed image-generation tasks with `notifyAgentOnFailure: true` were still being recorded as UI-only entries in the main program.

Fix applied:

- Added `shouldNotifyAgentOnFailure()`.
- Changed deferred delivery ordering so bridge targets are checked before UI-only handling.
- Changed UI-only failed tasks with `notifyAgentOnFailure: true` to deliver a hidden failed result and trigger the parent turn.
- Added tests for delivery ids, UI-only interlude records, failure notification, and bridge-target UI-only suppression.

### Duplicate Image Generation Display

- Live stream handling now resolves pending media-generation placeholders by task id.
- Replayed pending media-generation placeholders are dropped after a task has already resolved.
- Deferred interludes are appended by delivery identity and do not rebind later assistant text to an older media result.
- History reconstruction honors `sourceIndex` and `timelinePlacement: "after_anchor_message"`.
- Turn-input consumption records suppress duplicate deferred deliveries during session reload.

### Workflow API

- `agent()` validates option keys before starting isolated execution.
- Invalid `access` values fail early.
- Explicit unresolved `agentType` fails instead of falling back to the current agent.
- Unawaited `agent()` calls fail workflow execution.
- Reading `agent().result` fails immediately with a clear await-first error.
- Workflow node thread ids and child session metadata are propagated.

### Bridge Owner Session Compatibility

- Bridge owner sessions filter denied owner tools, including `computer`.
- Bridge-targeted deferred results remain available for bridge delivery and are not suppressed as inactive desktop sessions.

## Verification

Passed:

- `npm run typecheck:test`
- `npx vitest run tests/deferred-result-coordinator.test.ts tests/deferred-result-ext.test.ts tests/message-utils.test.ts tests/sessions-route.test.ts tests/session-coordinator-deferred-delivery.test.ts tests/workflow-host-api.test.ts tests/workflow-integration.test.ts tests/workflow-tool.test.ts desktop/src/react/__tests__/stores/chat-slice-interlude-order.test.ts desktop/src/react/__tests__/utils/history-builder.test.ts desktop/src/react/__tests__/hooks/use-stream-buffer.test.ts`

Test result:

- 11 test files passed.
- 143 tests passed.
- TypeScript test project passed.

Residual scans:

- No remaining use of `insertInterludeItemNearTaskResult`.
- No remaining use of `trailingDeferredTextRebindTargetId`.
- No remaining dead helper references for `deferredRecordToMediaResult` or `deferredRecordToInterludeBlock`.
- No remaining `hana.workflow.runtimeContract` in main workflow runtime.

## Report Cleanup

Removed old migration reports:

- `docs/openhanako-0.341.13-migration-recheck-2026-06-22.md`
- `docs/openhanako-0.341.19-migration-recheck-2026-06-22.md`

This file is the current retained migration report for the 0.341.19 recheck.

## Notes

- `npm` still prints `Unknown project config "min-release-age"`. This is an existing npm config warning and did not fail verification.
- No Windows installer or portable package build was run in this pass.
