# Plugin runtime

Node-side helper package for G-SAP plugins.

This package provides stable helper shapes for:

- tool definitions
- plugin lifecycle classes
- EventBus handler definitions
- network fetch capability types (`ctx.network.fetch`)
- provider declarations
- task and schedule helpers
- usage ledger helpers
- SessionFile media details

The runtime keeps source compatibility while G-SAP finishes its TypeScript conversion. See the root [PLUGIN_SDK.md](../../PLUGIN_SDK.md) for current authoring rules.

Plugins that need outbound HTTP should declare `network.fetch` in the manifest and call `ctx.network.fetch()` from tools, lifecycle code, or bus handlers. The host enforces allowed hosts, methods, timeouts, localhost policy, and response byte limits.
