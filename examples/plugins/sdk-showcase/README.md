# SDK Showcase Plugin

This example demonstrates the four SDK layers together:

- `@g-sap/plugin-runtime` for lifecycle, EventBus, tools, and SessionFile media details.
- `@g-sap/plugin-sdk` for iframe handshake and host capabilities.
- `@g-sap/plugin-components` for G-SAP-styled React iframe UI.
- `@g-sap/plugin-protocol` indirectly through the iframe SDK.

The `routes/page.js` file serves a minimal iframe shell. In a real plugin, bundle the UI from `ui/Panel.tsx` into `assets/panel.js` and `assets/panel.css`, then copy this directory into the G-SAP plugin directory.

G-SAP serves plugin static files through `/api/plugins/{pluginId}/assets/...` with a path-scoped asset session cookie. Keep only built UI files and public media under `assets/`; use `gsap.assets.url(path)` from browser code for images, JSON, wasm, or other static files referenced after the iframe has loaded.

Useful checks from the repo root:

```bash
npm test -- tests/plugin-sdk-examples.test.ts
npm run build:packages
```

The example requests `external.open` and `clipboard.writeText` in `manifest.json`. `toast.show` is available without a grant.
