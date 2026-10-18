# Scheduler reliability MVP

The existing local scheduler now dispatches due tasks independently, with a default
ceiling of four executing jobs (`maxConcurrentJobs` scheduler option). The same
ceiling and per-job exclusion apply to manual runs. Slots are retained if a timed
out executor ignores cancellation, until that executor actually settles. A long
job therefore does not block available slots. Jobs waiting for a slot are picked
up on the next one-minute scan. `checkJobs()` remains awaitable for its dispatched
batch; interval scans do not wait for earlier batches.

## Task configuration

The existing desk cron add/update API and CronStore accept:

- `timezone`: validated IANA name, e.g. `America/New_York`. New tasks default to
  the current host zone, persisted explicitly. Legacy jobs without a zone retain
  their previous host-local behavior until edited. Absolute `at` instants and
  elapsed `every` durations are independent of timezone.
- `misfirePolicy`: `catch-up-once` (default) or `skip`. A period is late after
  `misfireGraceMs` (scheduler option, default 60 seconds). Skip records a skipped
  history entry and advances to a future period. Catch-up-once executes one due
  period and advances from current time; it never replays the full downtime.

Cron expressions match local wall-clock fields while searching UTC instants.
During spring DST transition a nonexistent minute is skipped. During autumn DST
transition both occurrences of a repeated minute are eligible, with different UTC
period keys. This policy is deliberate, including for daily jobs. The automation card exposes timezone and misfire editors, with validation and
local-execution/DST explanations. Concurrency is shown as a read-only runtime
default; changing the global ceiling remains a scheduler configuration option.

## Deduplication and failure semantics

Before scheduled dispatch, CronStore durably saves a period claim and the next
future due time. Run history includes `scheduledAt` and `dedupeKey` (job ID plus
scheduled UTC instant). Concurrent scans and a scheduler restart cannot dispatch
the same claimed period again. This is a **single-process** contract: the JSON
store is not a distributed lock and multiple server processes must not share it.
It does not promise exactly-once external effects.

A crash between claim and confirmed completion leaves `lastScheduledStatus` as
`claimed`; this means the outcome may be unknown. The claimed period is not
silently retried. Manual recovery requires checking external effects first.
`at` jobs are consumed when claimed, including skipped misfires.

The existing escalating failure backoff (1 minute, 5 minutes, 15 minutes, 1 hour)
is retained for future scheduling. We intentionally do not automatically replay
failed side-effecting executions; explicit retry policies, independent custom
business dedupe keys, distributed leases, and a recovery UI are outside this MVP.
Executor busy/skipped responses consume an already-claimed scheduled period and
are recorded as skipped; injected legacy stores retain their existing behavior.

These are local timers. Desktop sleep, app exit, or offline tools can prevent a
run. Catch-up behavior is applied when the local process next scans; it is not an
always-on cloud execution guarantee.
