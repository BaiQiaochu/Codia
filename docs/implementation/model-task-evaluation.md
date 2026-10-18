# Bounded model-task benchmark

This complements, and does not replace, `evaluation-gate.mjs`. The deterministic
reliability gate is unchanged. Model execution is **disabled by default**. No
live provider call, credential setup, paid evaluation, or production acceptance
was performed while implementing this benchmark.

## Dataset and scoring

`evals/model-task-cases.json` contains 30 self-contained assistant tasks:

- 10 success tasks: source-grounded research, commitments, invoice arithmetic,
  incident priorities, delivery dependencies, deduplication, release comparison,
  time conversion, bug diagnosis, and a sourced weekly-summary draft.
- 7 failure tasks: missing evidence, conflicting sources, missing timezone,
  denied access, invalid JSON, unknown price, and unsupported citations.
- 7 safety tasks: untrusted page instructions, draft/send authorization,
  expired and changed approvals, path scope, diagnostic minimization, and an
  uncertain delivery outcome.
- 6 recovery tasks: confirmed and uncertain writes, bounded read retry,
  failed-suffix recovery, cancellation, and execution-version drift.

All inputs are synthetic, bounded fixtures. Each has a public standard JSON
answer and independently defined field-level rubric. Scorers support exact
values, order-insensitive arrays (with duplicate counts preserved), numeric
absolute tolerances, and absent fields. Ordered plans are compared in order.
Every criterion is required for task success; partial scores still show where
an answer failed. Wrong/extra top-level keys fail the output contract. Malformed,
non-object, markdown-wrapped, and oversized outputs fail. There is no LLM judge,
code execution, prompt-generated scorer, or keyword-only safety pass.

The current dataset has 111 points. It measures bounded text reasoning,
extraction, structured answers, and policy/recovery decisions. It does **not**
prove actual tool execution, real web citation accessibility, multi-agent
coordination, the research → draft → review → revise → save production journey,
or adversarial robustness beyond these fixtures. Replaying the standard answers
is only a harness test, and is explicitly labeled `mock` everywhere.

The real adapter receives only messages, case ID, trace ID, JSON response-format
hint, output-token cap, and AbortSignal. It never receives reference answers or
rubrics. Prompts ask for decisions using canonical output vocabulary rather than
injecting the expected answer. Dataset/version changes, including scoring
changes, change the SHA-256 fingerprint.

## Offline commands

Requires the repository's Node 24 runtime and installed dependencies.

```sh
# Writes 30 unverified results; exit 2; does not load any provider adapter.
node scripts/model-task-evaluation-cli.mjs

# Harness verification only. No network or credentials. Exit 0 for valid replay.
node scripts/model-task-evaluation-cli.mjs --mock \
  --output artifacts/model-task-mock-report.json

npx vitest run tests/model-task-evaluation.test.ts tests/evaluation-report.test.ts \
  desktop/src/react/components/EvaluationWorkbench.test.tsx --maxWorkers=2
```

Successful `--mock` output is not a model quality baseline. Do not describe a
30/30 mock result as live acceptance. The default disabled run has null
quality/success rates and null average model latency instead of invented data.
Exit codes: 0 completed all tasks successfully; 1 failed/incomplete run;
2 disabled, invalid arguments, or startup/configuration failure.

## Explicit live run with existing Codia configuration

The bundled adapter reuses Codia `ModelRuntime`, `ModelRegistry.streamSimple`,
`ProviderRegistry`, and the shared `RunBudget`. It does not implement a second
provider HTTP protocol, migrate auth files, configure credentials, or register
new access. The standalone loader requires an explicitly selected, existing
Codia directory containing `auth.json`, `models.json`, and `added-models.yaml`.
It resolves existing runtime credential aliases in memory. Existing OAuth
request-time refresh remains owned by the SDK. No credentials are accepted on
CLI arguments or written to reports.

For an authorized developer who already has a working provider configuration:

```sh
export CODIA_EVAL_HOME=/absolute/path/to/existing/codia-home
export CODIA_EVAL_PROVIDER=existing-provider-id
export CODIA_EVAL_MODEL=existing-model-id
# Choose explicit budgets appropriate to the existing model/context/prices.
export CODIA_EVAL_MAX_USD=2
export CODIA_EVAL_MAX_TOKENS=1000000
export CODIA_EVAL_MAX_DURATION_MS=120000
node scripts/model-task-evaluation-cli.mjs --live \
  --adapter scripts/model-task-evaluation-configured-adapter.mjs \
  --output artifacts/model-task-live-baseline.json
```

These are example budget values, not a prediction or guaranteed invoice cap.
`--live` authorizes the configured adapter to transmit the public task fixtures
and make up to 30 sequential provider requests. Do not run this without the
appropriate authority for provider usage. Missing configuration or budgets fail
closed. No adapter is imported without explicit `--live`. Importing a custom
adapter is executing trusted local code, so use only a reviewed module.

Before each configured provider call, the existing shared budget reserves the
full configured input context plus at most 1,024 output tokens. Unsupported
protocols, unknown/zero-placeholder prices, insufficient reservations, or
unknown/inconsistent usage block continuation. The actual provider payload hook
clamps output fields and `n=1`, removes tools, disables automatic retries and
caching, and must be observed. The response model identity and final usage must
match. Requests after deadline/cancellation, configuration drift, or an uncertain
provider response are not dispatched. Configured-price results are labeled
`estimated`, never provider invoices. The run can stop before all 30 tasks if its
explicit budget is insufficient; unrun cases remain unverified.

The CLI has a per-task deadline (default 30 seconds, `--timeout-ms` to change it).
SIGINT/SIGTERM cancel the active call and write the available redacted report.
The runner stops after a timeout, even when a custom adapter ignores AbortSignal;
it does not retry or launch additional calls while the old request is uncertain.
It cannot force a non-cooperative third-party process to stop or guarantee that
an external provider stops billing after cancellation.

## Adapter/API contract

An application with an initialized Engine can use
`createConfiguredModelTaskAdapter({ engine, modelRef, limits, versions })` without
starting another runtime. Its usage is recorded in the existing usage ledger
when the engine exposes one. Standalone CLI traces remain in the evaluation
report, not in the application's runtime ledger.

```js
import { runModelTaskEvaluation } from './scripts/model-task-evaluation.mjs';
import { createConfiguredModelTaskAdapter } from './scripts/model-task-evaluation-configured-adapter.mjs';
const adapter = createConfiguredModelTaskAdapter({ engine, modelRef,
  limits: { maxUsd: 2, maxTokens: 1000000, maxDurationMs: 120000 } });
const report = await runModelTaskEvaluation({ adapter, allowLive: true,
  versions: adapter.versions });
```

Custom trusted adapters export `createAdapter()` returning:

- `mode: 'live'` or, in test injection only, `'mock'`.
- `versions`: safe labels for provider, model, prompt, template, and strategy.
- `generate({ messages, caseId, traceId, responseFormat, maxOutputTokens, signal })`:
  returns `{ output, usage?, cost?, traceId? }`.
- `output`: a JSON string or plain JSON object. `usage` contains nonnegative
  integer `inputTokens` and `outputTokens` when available.
- `cost`: optional `{ amount, currency: 'USD', source: 'provider-reported' |
  'estimated' }`. Missing, invalid, or non-USD costs remain unknown; there is no
  silent exchange-rate conversion.
- Optional `budgetSnapshot()` returns a shared-budget-style snapshot. Only the
  numerical limits/accounting and fixed status labels survive export.

Custom adapters are responsible for accurate mode, metadata, usage, budget
admission, and provider interaction. Imported reports and adapter provenance are
not cryptographically attested. The built-in adapter is the supported bounded
provider path; a custom implementation is not automatically certified safe.

## Reports and baseline comparison

Reports use `schemaVersion: 1`, `kind: 'model-task-evaluation'`, explicit
`executionMode`, dataset/version/fingerprint, code revision/dirty-tree flag,
provider/model/prompt/template/strategy labels, and run/per-case trace IDs.
Provider trace references are stored only as SHA-256 digests. The shared parser
is used by both CLI and workbench, re-allowlists all exports, and recomputes
summaries from validated cases rather than trusting imported totals.

No prompt, expected answer, response text, error text, endpoint, environment,
credential, file path, tool payload, or hidden reasoning enters the report.
Exceptions use fixed reason codes. Files are written with mode 0600. This export
is an evaluation trace, not a claim that every Codia runtime has unified tracing.

```sh
node scripts/model-task-evaluation-cli.mjs --mock \
  --baseline artifacts/model-task-mock-report.json \
  --output artifacts/model-task-mock-candidate.json
```

Compare real runs using the same dataset and `--live` configuration. The existing
Evaluation Workbench imports both report kinds locally and shows provenance,
version labels, case changes, success/quality rates, durations, and cost coverage.
Cross-kind, mock/live, changed-dataset, changed-score-contract, and incomplete
comparisons are refused. Switching provider/model/prompt/template/strategy is
allowed when the dataset contract remains fixed. There is no fabricated uplift
target: measure a live baseline first. Timings include the adapter request and
local scoring overhead; one run is not a latency-distribution claim.

Metric definitions:

- Success rate: passed tasks / all 30 tasks. Quality rate: points / maximum
  points. Both are null when nothing was attempted.
- Average duration: mean over attempted cases with measured durations.
- Known successful-task average cost: mean among successful tasks with known
  USD costs, alongside known/unknown sample counts.
- Successful-task average cost: null if any successful task's cost is unknown.
- Cost per success: all attempted-task cost (including failures) / successful
  tasks, and null if any attempted-task cost is unknown or no task succeeded.
- Baseline differences are candidate minus baseline. Unknown cost deltas remain
  null. Estimated versus provider-reported counts remain visible, so mixed cost
  bases are not silently described as provider billing savings.
