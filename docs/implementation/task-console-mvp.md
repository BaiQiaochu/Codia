# Task console and template MVP

## Entry point

The primary navigation contains **任务与成果**. The panel polls the existing activity stores every five seconds and shows workflow/subagent/desk records, company reports and artifact references, real lifecycle states, owner, timestamps, approvals, interrupted approvals and links to source sessions. Workflow nodes open their child session for artifact access. Merely reading the console does not activate a plugin or create a company.

`GET /api/task-console` remains an owner-only read-only projection. Provider invoice cost stays explicitly unknown; template runs additionally show separately labeled local configured-price commitments and pending reservations. These are persisted with the existing activity hub. A restarted in-flight run cannot turn its last checkpoint into a claim of final known usage.

## Experimental template execution

Three immutable `1.0.0` templates live in `shared/task-console/templates.ts`: research brief, repository check/patch candidate, and weekly draft. Their template-level qualification remains `mock-only` until actual end-to-end acceptance evidence exists.

`POST /api/task-console/preflight` resolves an exact version, checks inputs and weekly IANA timezone, inspects registered tools, current MCP client connection state, authorized real workspace paths, the actual configured model's current qualification record, local budget bounds and the existing workflow/session entry point. Reading preflight never invokes a model or tools. Caller-supplied passing flags cannot authorize execution.

The UI offers a separate, explicit model capability probe, with text/tool checks selected by default and optional native structured-output/vision checks. It explains that probes can incur fees under a separate use of the entered budget. Vision needs explicit acknowledgment of fixture image token-price assumptions. Results display capability status and corrective suggestions. A capability pass allows experimental execution; it does not qualify the template's end-to-end quality.

`POST /api/task-console/execute` requires an explicit experimental launch, exact version and request ID. It recomputes preflight, detects model/agent/session changes, constructs canonical code with inputs passed only as JSON args, and invokes the existing `Agent.workflowTool`. Four serial steps pass previous results into the next step. User input is never interpolated into script source. The server pins the current model, workspace and tool allowlists through trusted context. Existing tools, sandbox boundaries, approval gates, journal, deferred result store and activity hub remain the execution owners. No second execution engine is introduced.

A successful POST returns HTTP 202 and a persisted workflow run ID, never a fabricated successful result. The UI distinguishes started from completed and allows viewing actual status/results. Identical concurrent request IDs share one launch; changed data under the same ID is rejected. An exclusive claim is fsynced before dispatch and the run-ID acknowledgment is atomically persisted afterward. Across restart, a completed request returns its original run ID; an interrupted/unacknowledged claim remains blocked for inspection and is never automatically retried. A missing/unwritable durable directory blocks launch. On Windows where Node cannot fsync directories, files are still fsynced and claims/renames are atomic; process-crash deduplication is supported, but power-loss durability is not promised. Other I/O errors block dispatch. The in-process wait cache is bounded to 1,000 admissions. Before sending, the UI persists only the request ID and SHA-256 input fingerprint in localStorage, never raw inputs or credentials. A network retry or page reload reuses that ID for identical input; changed input cannot silently discard an unresolved request. A server-unknown response blocks further launch attempts until the user explicitly confirms reviewing existing runs. A confirmed successful receipt clears the pending marker. Storage failures block dispatch. The UI does not retry uncertain launches automatically. Active root runs expose an explicit stop request; already-started external operations may have taken effect and are not undone.

Weekly execution produces this period's draft only. It does not create an automation or send anything. The existing automation UI remains the scheduling owner. A fallback button can still append the canonical draft to ordinary chat, but this path does not activate the template's budget contract.

## Local budget contract

`lib/workflow/run-budget.ts` provides an atomic shared RunBudget for all nodes of one run:

- Positive token/USD/step/duration/per-call output limits, plus a model-call ceiling
- Before every provider call, reserve the entire configured context window plus capped output, not an approximate prompt-token count
- Reserve the configured maximum input/cache rate plus output rate; zero-placeholder or unknown prices and unsupported adapters fail closed
- Outstanding reservations participate in concurrent admission, so two parallel calls cannot each spend the same remaining allowance
- Synchronously checkpoint reservations through activity-hub observers before dispatch; a failed checkpoint blocks execution
- Only reliable final usage frees unused allowance. Missing/inconsistent usage, aborts and over-reservation responses retain reservations and block further calls
- Persisted interrupted budget runs remain blocked for safe inspection; the generic recovery draft cannot drop their original budget constraints

`run-budget-stream.ts` wraps the actual isolated session stream. It caps SDK options and then the final payload after sampling/host overrides, requires observation of that final-payload hook, disables provider retries, forces SSE and no requested caching, rejects media and provider-hosted paid tools, and replaces untrustworthy terminal success with an error before any returned tool calls can run. The core isolated executor disables auto-compaction/auto-retry and delegation tools that could escape the contract. Workflow dispatch limits and abort signals enforce step and elapsed-time bounds; unknown in-flight charges stay reserved.

Supported guarded adapters currently are OpenAI completions, OpenAI responses and Anthropic messages. The full-window reservation is intentionally conservative: a 128k-window model needs at least that window plus the output cap available before each call. Users may need a larger allowance or a smaller-window model even for a short prompt.

This is a locally enforced configured-price admission contract, **not a hard cap on a provider invoice**. Model metadata can be inaccurate, providers may ignore limits, and external tool/service charges are not included. Remote cancellation is best-effort; unknown usage is never labeled free. Real provider qualification/acceptance still needs authorized credentials and possible paid calls.

## Verification

- `tests/task-console.test.ts`: record projection, company artifacts, child-session links, owner-only policy, exact versions, inputs/timezone, unknown-price handling
- `tests/task-console-environment.test.ts`: existing tool/MCP state, authorized paths/symlink escape, immutable plans, forged preflight rejection
- `tests/task-console-execution.test.ts`: HTTP launch through the real workflow tool and sandbox, mock provider guard, four serial steps and local fixture artifacts for all three templates; duplicate launches, step/time limits, unknown usage, production rejection of injected qualification
- `tests/run-budget.test.ts`: concurrent reservations, known-use settlement, unknown-use freeze, changed-model rejection, ceilings and final-payload enforcement
- `desktop/src/react/components/TaskConsolePanel.test.tsx`: actual records and session navigation, explicit draft handoff, launch/probe controls and read errors
- Core/workflow integration tests verify trusted budget context reaches actual isolated SDK sessions and cannot be overridden by workflow node options

These tests are deterministic/local and use no real paid model calls. Template-level live qualification is intentionally not claimed.

### Explicit side-effect approvals for templates

Budgeted template nodes preserve the existing `ask` mode instead of inheriting the ordinary background-subagent collapse to `operate`. Read-only nodes stay read-only. Shell commands, file modifications and unclassified connector actions go through the existing human confirmation cards, bound to their parameters; reads remain available. This prevents the template prompt from being the only safeguard against a publishing command. It is not a new shell sandbox or a claim that approved arbitrary shell commands cannot perform additional effects. Existing non-template subagents retain their prior permission behavior.
