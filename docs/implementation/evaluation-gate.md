# Deterministic reliability evaluation gate

Run `node scripts/evaluation-gate.mjs` from the checkout (Node 24 and dependencies
installed). Optional first argument selects the JSON report destination. The
default is `artifacts/evaluation-report.json`. Exit 0 requires all 30 explicitly
scored manifest cases to pass and the Vitest invocation to exit successfully.
Workers are bounded to two. No network/model credentials are required.

`evals/reliability-cases.json` binds each case to a source test and assertion name.
The 30 cases cover scheduling, approval binding, workflow error propagation,
redaction, token-budget calculation, structured output, and concurrency. Each is
worth one point. Missing, skipped, duplicate, or failed assertions cannot produce
a green gate. Additional tests in the selected files also run; a failure in one
makes the gate fail even if the 30 named assertions passed.

The exported report contains a run trace ID, per-case outcomes, duration and score,
and links back to repository test paths. It excludes raw logs, environment values,
model prompts, tool arguments, stack traces, and absolute paths, and passes the
remaining allowlisted values through the existing log redactor. Raw Vitest JSON
is temporary and removed after scoring. Existing runtime diagnostic-package
export remains the runtime investigation route; this report is an evaluation
trace, not a claim that all runtime systems already share a single trace ID.

## What this gate does not measure

This is a deterministic engineering regression baseline, not 30 live user tasks.
Every report explicitly marks real-model validation pending. The requested live
research → draft → review → revise → save journey, provider/prompt quality
comparisons, task-success cost, latency distribution, and actual provider baselines still
require a separate controlled model run. The complementary [bounded model-task
benchmark](model-task-evaluation.md) now supplies 30 scored task fixtures, an
opt-in configured-provider runner, and baseline comparison; its offline reference
replay does not constitute live model validation. They must not
be described as passed based on this gate. Credentials and external side effects
are intentionally absent from these deterministic tests.
