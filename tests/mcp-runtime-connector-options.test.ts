import { describe, expect, it, vi } from "vitest";
import { McpRuntime } from "../plugins/mcp/lib/mcp-runtime.js";

function makeRuntime(initialConfig = {}) {
  let stored = initialConfig;
  const runtime = new McpRuntime({
    dataDir: "unused",
    config: {
      get: vi.fn(() => stored),
      set: vi.fn((_key, value) => { stored = value; }),
    },
    log: { warn: vi.fn(), error: vi.fn() },
    registerTool: vi.fn(() => vi.fn()),
    bus: { request: vi.fn(async () => ({ config: {} })) },
  });
  return runtime;
}

describe("McpRuntime connector options", () => {
  it("persists and exposes original connector metadata with redacted secrets", () => {
    const runtime = makeRuntime();

    runtime.addConnector({
      name: "Remote",
      description: "remote connector",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret" },
      timeout: 45,
      autoStart: true,
    });

    const state = runtime.getState();
    expect(state.connectors[0]).toMatchObject({
      description: "remote connector",
      headers: { Authorization: "********" },
      timeout: 45,
      autoStart: true,
    });
  });

  it("keeps masked secrets when editing connector fields", async () => {
    const runtime = makeRuntime({
      enabled: true,
      connectors: [{
        id: "local",
        name: "Local",
        transport: "stdio",
        command: "npx",
        env: { API_KEY: "secret" },
        authorizationToken: "token",
      }],
    });

    await runtime.updateConnector("local", {
      name: "Local Edited",
      transport: "stdio",
      command: "npx",
      env: { API_KEY: "********" },
      authorizationToken: "********",
      autoStart: true,
    });

    const config = runtime.getConfig();
    expect(config.connectors[0]).toMatchObject({
      name: "Local Edited",
      env: { API_KEY: "secret" },
      authorizationToken: "token",
      autoStart: true,
    });
  });
});
