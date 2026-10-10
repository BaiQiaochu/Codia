# Codia Test Policy

Codia uses risk-driven tests. Test value comes from protecting contracts, old-user safety, packaging, and security boundaries, not from keeping a large file count.

## Test Layers

- `contract`: public behavior, architecture boundaries, permissions, and external protocols.
- `regression`: a real bug captured once. When behavior stabilizes, merge it into a behavior-named contract test.
- `unit`: pure logic and small modules with stable inputs and outputs.
- `route`: HTTP or WebSocket boundaries, including auth, error shape, and resource scope.
- `build`: packaging, runtime assets, native dependencies, preload, and server bundle contracts.
- `platform`: path, shell, sandbox, and OS-specific behavior across macOS, Windows, and Linux.

## Keep Tests When

- They protect security, permissions, credentials, secrets, resource grants, or remote access.
- They protect cross-session, cross-agent, plugin, or workspace ownership.
- They protect Resource, SessionFile, MediaItem, sidecar recovery, or legacy migration behavior.
- They protect build, packaged server runtime, native addons, preload output, or plugin runtime dependencies.
- They protect provider, Bridge, plugin, coding mode, or other external protocol contracts.
- They protect cross-platform path, shell, sandbox, or installer behavior.
- They catch a historical bug that has not yet been absorbed into a stronger contract test.

## Delete Or Merge Tests When

- They only test temporary implementation details.
- They duplicate a stronger contract test.
- The old feature no longer exists and no migration or read compatibility remains.
- An issue-specific acceptance test has been absorbed by a permanent behavior-named contract.
- They only lock unstable copywriting instead of stable error type, code, or key fields.
- They mock private fields where a public API or service contract can express the behavior.

## Required Validation

Run focused tests for affected files first. Before handoff or release, run the available full validation set:

```bash
npm test
npm run typecheck
npm run lint
```
