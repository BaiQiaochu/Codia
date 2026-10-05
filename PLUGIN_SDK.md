# G-SAP Plugin SDK

This document describes the source-level SDK pieces used by built-in and external plugins. Public documentation uses G-SAP names; existing internal package scopes may remain as compatibility aliases until the TypeScript and package rename migration is complete.

## Packages

The SDK is split into four workspace packages:

- `@g-sap/plugin-protocol` (`packages/plugin-protocol`): shared protocol constants and message shapes for iframe/host communication.
- `@g-sap/plugin-sdk` (`packages/plugin-sdk`): browser-side iframe helpers for host handshake, asset URLs, same-origin plugin API calls, resize, toast, external links, clipboard, and raw host requests.
- `@g-sap/plugin-runtime` (`packages/plugin-runtime`): Node-side helpers for tools, lifecycle plugins, EventBus handlers, network fetch capability, SessionFile media details, providers, tasks, and request-pipeline extensions.
- `@g-sap/plugin-components` (`packages/plugin-components`): React primitives and styles for plugin iframe UI.

Run this after SDK changes:

```bash
npm run build:packages
```

## Runtime Tool Example

```ts
import { defineTool } from "./packages/plugin-runtime/src/index";

export const summarizeTool = defineTool({
  name: "summarize_note",
  description: "Summarize a short note",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" }
    },
    required: ["text"]
  },
  async execute(input, ctx) {
    // Requires "capabilities": ["network.fetch"] plus manifest.network.allowedHosts.
    const resp = await ctx.network.fetch("https://api.example.com/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.text })
    });
    if (!resp.ok) throw new Error(`summarize failed: ${resp.status}`);
    return { text: String(input.text || "").slice(0, 200) };
  }
});
```

Tools that return files should register them through the host SessionFile/resource APIs instead of returning raw local paths. This keeps desktop preview, mobile preview, bridge delivery, and plugin cards consistent.

## iframe UI Rules

- Load static files only through the plugin asset route.
- Request host actions through the SDK bridge; do not call host internals from iframe code.
- Keep secrets on the backend side.
- Use host theme tokens or plugin component tokens instead of hard-coded theme colors.
- Treat iframe tickets and asset cookies as short-lived transport credentials, not persistent auth storage.

## Host Capability Requests

Common iframe capability requests:

```ts
gsap.ready();
gsap.ui.resize({ height: 360 });
await gsap.toast.show({ message: "完成" });
await gsap.external.open({ url: "https://example.com" });
await gsap.clipboard.writeText({ text: "copied" });
const imageUrl = gsap.assets.url("images/example.png");
const apiResp = await gsap.api.fetch("api/translate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "hello" })
});
```

The exact import path depends on whether the plugin is built inside this monorepo or bundled externally. During the package rename migration, use the compatibility alias already present in the repo rather than inventing a second package name.

## Network And API Helpers

Backend plugin code must use `ctx.network.fetch` for outbound HTTP calls. It is deny-by-default: the manifest must declare `network.fetch` and list allowed hosts, methods, timeout, and byte limits.

```json
{
  "capabilities": ["network.fetch"],
  "network": {
    "allowedHosts": ["api.example.com"],
    "methods": ["GET", "POST"],
    "defaultTimeoutMs": 15000,
    "maxResponseBytes": 5242880
  }
}
```

Iframe code should use `gsap.api.url()` or `gsap.api.fetch()` for same-origin plugin route calls. `gsap.api.fetch()` automatically sends the plugin surface session header; do not call `/api/plugins/...` by hand from iframe UI.

## Provider Helpers

Provider declarations should be data-first and capability-specific:

```ts
import { defineProvider } from "./packages/plugin-runtime/src/index";

const provider = defineProvider({
  id: "local-image-cli",
  displayName: "Local Image CLI",
  authType: "none",
  runtime: {
    kind: "local-cli",
    protocolId: "local-cli-media",
    command: {
      executable: "local-image-cli",
      args: [
        { literal: "generate" },
        { option: "--prompt", from: "prompt" },
        { option: "--output", from: "outputDir" }
      ],
      timeoutMs: 120000,
      output: { kind: "file_glob", directory: "outputDir", pattern: "*.png" }
    }
  },
  capabilities: {
    chat: { projection: "none" },
    media: {
      imageGeneration: {
        models: [{
          id: "local-image-model",
          displayName: "Local Image Model",
          protocolId: "local-cli-media",
          inputs: ["text"],
          outputs: ["image"]
        }]
      }
    }
  }
});

export const { id, displayName, authType, runtime, capabilities } = provider;
```

CLI providers must use structured argument bindings. Do not build shell strings from user input.

## Verification

```bash
npm run build:packages
npm test -- tests/plugin-sdk-assets.test.ts tests/plugin-routes.test.ts tests/plugin-manager.test.ts
```

See `examples/plugins/sdk-showcase/` for a compact working plugin.
