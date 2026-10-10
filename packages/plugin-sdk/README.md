# Plugin iframe SDK

Browser-side SDK helpers for Codia iframe plugins.

This package provides:

- iframe ready handshake
- host request helpers
- same-origin plugin API helpers (`codia.api.url` and `codia.api.fetch`)
- resize notifications
- theme snapshots and theme subscriptions
- toast, external-open, and clipboard capability wrappers

The public package scope is being normalized during the TypeScript conversion. Use the workspace package from this repository when developing bundled examples, and see the root [PLUGIN_SDK.md](../../PLUGIN_SDK.md) for current guidance.

`codia.api.fetch(path, init)` is for iframe UI calling its own plugin backend routes under `/api/plugins/:pluginId/...`. The helper rejects unsafe paths and adds the surface session header automatically.
