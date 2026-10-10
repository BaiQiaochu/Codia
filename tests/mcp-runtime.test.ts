// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import {
  McpRuntime,
  MCP_CONNECTORS_STATUS_TOOL_NAME,
  createMcpConnectorsStatusToolDefinition,
  createMcpToolDefinition,
  isMcpToolEnabledForAgentConfig,
  normalizeMcpConfig,
  toMcpToolId,
} from "../plugins/mcp/lib/mcp-runtime.js";
import { McpHttpError } from "../plugins/mcp/lib/mcp-http-client.js";

describe("MCP runtime policy", () => {
  it("uses stable sanitized tool ids for dynamic MCP tools", () => {
    expect(toMcpToolId("github.com", "search/repositories")).toBe("github_com_search_repositories");
  });

  it("marks MCP dynamic tools as legacy Pi-signature tools", () => {
    const tool = createMcpToolDefinition({
      connectorId: "github",
      toolName: "search",
      getGlobalEnabled: () => true,
      getAgentConfig: vi.fn(async () => ({})),
      callTool: vi.fn(),
    });

    expect(tool.invocationStyle).toBe("pi_tool");
  });

  it("requires global, server, and tool-level agent enablement before exposing a tool", () => {
    const enabledAgent = {
      mcp: {
        connectors: {
          github: {
            enabled: true,
            tools: { search: true },
          },
        },
      },
    };

    expect(isMcpToolEnabledForAgentConfig(enabledAgent, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(true);

    expect(isMcpToolEnabledForAgentConfig(enabledAgent, {
      globalEnabled: false,
      serverId: "github",
      toolName: "search",
    })).toBe(false);

    expect(isMcpToolEnabledForAgentConfig({
      mcp: { connectors: { github: { enabled: false, tools: { search: true } } } },
    }, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(false);

    expect(isMcpToolEnabledForAgentConfig({
      mcp: { connectors: { github: { enabled: true, tools: { search: false } } } },
    }, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(false);
  });

  it("keeps backward compatibility with the previous mcp.servers agent config shape", () => {
    expect(isMcpToolEnabledForAgentConfig({
      mcp: { servers: { github: { enabled: true, tools: { search: true } } } },
    }, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(true);
  });

  it("normalizes remote connectors as the primary config shape", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        {
          id: "github.com",
          name: "GitHub",
          url: "https://mcp.github.com/mcp",
          authType: "bearer",
          authorizationToken: "token-123",
          tools: [{ name: "search", description: "Search repositories" }],
        },
      ],
    });

    expect(config.enabled).toBe(true);
    expect(config.connectors[0]).toMatchObject({
      id: "github_com",
      name: "GitHub",
      transport: "remote",
      url: "https://mcp.github.com/mcp",
      authType: "bearer",
      authorizationToken: "token-123",
    });
    expect(config.servers).toEqual(config.connectors);
  });

  it("normalizes Cherry-style MCP server fields into Codia connectors", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        {
          id: "cherry-http",
          name: "Cherry HTTP",
          type: "streamableHttp",
          baseUrl: "https://mcp.example.com/mcp",
          description: "Remote MCP server",
          headers: {
            Authorization: "Bearer header-token",
            "X-API-Key": "key-123",
          },
          timeout: "45",
          isActive: true,
        },
        {
          id: "cherry-stdio",
          name: "Cherry Stdio",
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-server-example"],
          env: { API_KEY: "secret" },
          registryUrl: "https://registry.npmmirror.com",
          autoStart: true,
        },
      ],
    });

    expect(config.connectors[0]).toMatchObject({
      id: "cherry-http",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      description: "Remote MCP server",
      headers: {
        Authorization: "Bearer header-token",
        "X-API-Key": "key-123",
      },
      timeout: 45,
      autoStart: true,
    });
    expect(config.connectors[1]).toMatchObject({
      id: "cherry-stdio",
      transport: "stdio",
      command: "npx",
      env: { API_KEY: "secret" },
      registryUrl: "https://registry.npmmirror.com",
      autoStart: true,
    });
  });

  it("migrates the earlier local server config into connectors", () => {
    const config = normalizeMcpConfig({
      servers: [
        {
          id: "local-github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      ],
    });

    expect(config.connectors[0]).toMatchObject({
      id: "local-github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(config.servers).toEqual(config.connectors);
  });

  it("returns connector state and a servers alias for API compatibility", () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "github",
          name: "GitHub",
          url: "https://mcp.github.com/mcp",
          tools: [{ name: "search" }],
        },
      ],
    };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-test",
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: console,
    });

    const state = runtime.getState({
      mcp: {
        connectors: {
          github: { enabled: true, tools: { search: true } },
        },
      },
    });

    expect(state.connectors[0]).toMatchObject({
      id: "github",
      transport: "remote",
      status: "stopped",
    });
    expect(state.servers).toEqual(state.connectors);
    expect(state.agentConfig).toEqual({
      connectors: {
        github: { enabled: true, tools: { search: true } },
      },
      servers: {
        github: { enabled: true, tools: { search: true } },
      },
    });
  });

  it("redacts connector secrets from public state without dropping their keys", () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "private",
          name: "Private",
          command: "npx",
          env: {
            BASE_URL: "https://internal.example.com",
            API_KEY: "secret",
          },
          headers: {
            Authorization: "Bearer secret",
            "X-Trace": "trace-id",
          },
          authorizationToken: "token-123",
          oauthClientSecret: "client-secret",
        },
      ],
    };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-test",
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: console,
    });

    const [connector] = runtime.getState().connectors;

    expect(connector.env).toEqual({
      BASE_URL: "********",
      API_KEY: "********",
    });
    expect(connector.headers).toEqual({
      Authorization: "********",
      "X-Trace": "********",
    });
    expect(connector.authorizationToken).toBe("********");
    expect(connector.oauthClientSecret).toBe("********");
  });

  it("surfaces connector start errors in public state", async () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "local",
          name: "Local",
          command: "npx",
          args: ["-y", "broken-mcp"],
        },
      ],
    };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-test",
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: console,
    }, {
      clientFactory: () => ({
        running: false,
        start: vi.fn(async () => {
          throw new Error("spawn EINVAL");
        }),
        stop: vi.fn(async () => {}),
      }),
    });

    await expect(runtime.startConnector("local")).rejects.toThrow("spawn EINVAL");

    expect(runtime.getState().connectors[0]).toMatchObject({
      id: "local",
      status: "stopped",
      error: "spawn EINVAL",
    });
  });

  it("executes settings actions through the runtime and returns a settings update", async () => {
    let stored = { enabled: false, connectors: [] };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-test",
      config: {
        get: vi.fn(() => stored),
        set: vi.fn((_key, value) => {
          stored = value;
        }),
      },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: console,
    });

    const result = await runtime.handleSettingsAction({
      action: "mcp.connector.add",
      agentId: "Codia",
      payload: {
        name: "GitHub",
        transport: "remote",
        url: "https://mcp.github.com/mcp",
        authType: "bearer",
        authorizationToken: "secret-token",
        enableGlobal: true,
      },
    });

    expect(stored.enabled).toBe(true);
    expect(stored.connectors[0]).toMatchObject({
      id: "GitHub",
      name: "GitHub",
      url: "https://mcp.github.com/mcp",
      authorizationToken: "secret-token",
    });
    expect(result.settingsUpdate).toMatchObject({
      status: "applied",
      action: "mcp.connector.add",
      key: "mcp.connector.GitHub",
      changes: [
        expect.objectContaining({
          key: "mcp.connector.GitHub",
          after: "added",
        }),
        expect.objectContaining({
          key: "mcp.enabled",
          after: "true",
        }),
      ],
    });
    expect(result.settingsUpdate.summary).not.toContain("secret-token");
  });

  it("returns an explicit tool error when MCP is globally disabled at call time", async () => {
    const callTool = vi.fn();
    const tool = createMcpToolDefinition({
      serverId: "github",
      toolName: "search",
      description: "Search repositories",
      inputSchema: { type: "object", properties: {} },
      getGlobalEnabled: () => false,
      getAgentConfig: () => ({
        mcp: { connectors: { github: { enabled: true, tools: { search: true } } } },
      }),
      callTool,
    });

    const result = await tool.execute({}, { agentId: "Codia" });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/MCP is disabled/);
  });

  it("returns an explicit tool error when the per-agent MCP tool switch is off", async () => {
    const callTool = vi.fn();
    const tool = createMcpToolDefinition({
      serverId: "github",
      toolName: "search",
      description: "Search repositories",
      inputSchema: { type: "object", properties: {} },
      getGlobalEnabled: () => true,
      getAgentConfig: () => ({
        mcp: { connectors: { github: { enabled: true, tools: { search: false } } } },
      }),
      callTool,
    });

    const result = await tool.execute({}, { agentId: "Codia" });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/not enabled for this agent/);
  });
});

describe("MCP connectors status tool", () => {
  function createStoredRuntime(stored) {
    const registered = [];
    const disposed = [];
    let counter = 0;
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-test",
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      registerTool: vi.fn((definition) => {
        const id = counter++;
        registered.push({ id, definition });
        return () => { disposed.push(id); };
      }),
      bus: { request: vi.fn() },
      log: console,
    });
    return { runtime, registered, disposed };
  }

  function findStatusTool(registered) {
    return registered
      .map((entry) => entry.definition)
      .find((definition) => definition.name === MCP_CONNECTORS_STATUS_TOOL_NAME);
  }

  it("registers a read-only connectors-status tool alongside cached tools", () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime, registered } = createStoredRuntime(stored);

    runtime.registerCachedTools();

    const statusTool = findStatusTool(registered);
    expect(statusTool).toBeTruthy();
    expect(statusTool.name).toBe(MCP_CONNECTORS_STATUS_TOOL_NAME);
    expect(statusTool.invocationStyle).toBe("pi_tool");
    expect(statusTool.metadata).toMatchObject({ kind: "mcp", readOnly: true });
    // Diagnostic tool takes no input.
    expect(statusTool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("reports each connector status and tool count from getState", async () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }, { name: "issues" }] },
        { id: "local", name: "Local", command: "npx", tools: [] },
      ],
    };
    const { runtime, registered } = createStoredRuntime(stored);
    runtime.registerCachedTools();
    const statusTool = findStatusTool(registered);

    const result = await statusTool.execute("call-1", {}, { agentId: "Codia" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.enabled).toBe(true);
    expect(payload.connectors).toEqual([
      expect.objectContaining({
        id: "github",
        name: "GitHub",
        transport: "remote",
        status: "stopped",
        error: "",
        toolCount: 2,
      }),
      expect.objectContaining({
        id: "local",
        name: "Local",
        transport: "stdio",
        status: "stopped",
        toolCount: 0,
      }),
    ]);
  });

  it("surfaces connector errors and running status without leaking secrets", async () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "private",
          name: "Private",
          command: "npx",
          env: { API_KEY: "super-secret-value" },
          headers: { Authorization: "Bearer super-secret-token" },
          authorizationToken: "raw-bearer-token",
          oauthClientSecret: "raw-client-secret",
          tools: [{ name: "ping" }],
        },
      ],
    };
    const { runtime, registered } = createStoredRuntime(stored);
    // Simulate a running client and a recorded error to prove status is sourced live.
    runtime.clients.set("private", { running: true });
    runtime.clientErrors.set("private", "spawn EACCES");
    runtime.registerCachedTools();
    const statusTool = findStatusTool(registered);

    const result = await statusTool.execute("call-1", {}, { agentId: "Codia" });
    const text = result.content[0].text;
    const payload = JSON.parse(text);

    expect(payload.connectors[0]).toMatchObject({
      id: "private",
      status: "running",
      error: "spawn EACCES",
    });

    // Hard guarantee: no raw secret material anywhere in the serialized output.
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("raw-bearer-token");
    expect(text).not.toContain("raw-client-secret");
  });

  it("only exposes the status tool while MCP is globally enabled", async () => {
    const stored = {
      enabled: false,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime, registered } = createStoredRuntime(stored);
    runtime.registerCachedTools();
    const statusTool = findStatusTool(registered);

    expect(statusTool.isEnabledForAgentConfig({})).toBe(false);

    stored.enabled = true;
    expect(statusTool.isEnabledForAgentConfig({})).toBe(true);
  });

  it("disposes the status tool together with cached tools", () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime, registered, disposed } = createStoredRuntime(stored);
    runtime.registerCachedTools();

    const statusEntry = registered.find((entry) => entry.definition.name === MCP_CONNECTORS_STATUS_TOOL_NAME);
    expect(statusEntry).toBeTruthy();
    expect(disposed).not.toContain(statusEntry.id);

    // Re-registering must dispose the prior status tool disposer.
    runtime.registerCachedTools();
    expect(disposed).toContain(statusEntry.id);
  });

  it("builds a status definition decoupled from any specific connector", async () => {
    const getState = vi.fn(() => ({
      enabled: true,
      connectors: [
        {
          id: "github",
          name: "GitHub",
          transport: "remote",
          status: "running",
          error: "",
          authStatus: "token",
          authorizationToken: "********",
          oauthClientSecret: "********",
          env: { API_KEY: "********" },
          headers: { Authorization: "********" },
          tools: [{ name: "search" }, { name: "issues" }],
        },
      ],
    }));
    const tool = createMcpConnectorsStatusToolDefinition({
      getState,
      getGlobalEnabled: () => true,
    });

    expect(tool.name).toBe(MCP_CONNECTORS_STATUS_TOOL_NAME);
    expect(tool.metadata).not.toHaveProperty("connectorId");

    const result = await tool.execute("call-1", {}, {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.connectors[0]).toMatchObject({
      id: "github",
      transport: "remote",
      status: "running",
      authStatus: "token",
      toolCount: 2,
    });
    expect(getState).toHaveBeenCalled();
  });
});

//
// dedup, persistence of DCR products, and the two distinct write-back paths
// (refresh keeps the live client; full re-auth stops it).
describe("MCP runtime OAuth token refresh", () => {
  function makeRefreshRuntime(connector, { fetchImpl } = {}) {
    let current = { enabled: true, connectors: [connector] };
    const setSpy = vi.fn((_key, value) => { current = { ...current, ...value }; });
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-refresh-test",
      config: {
        get: vi.fn(() => current),
        set: setSpy,
      },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }, { fetchImpl });
    return { runtime, setSpy, getConfig: () => current };
  }

  function tokenResponse(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const BASE_OAUTH_CONNECTOR = {
    id: "notion",
    name: "Notion",
    url: "https://mcp.example.com/mcp",
    authType: "oauth",
    oauthClientId: "client-id",
  };

  it("returns the existing access token when it is not near expiry", async () => {
    const fetchImpl = vi.fn();
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-current",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 3_600_000,
      },
    }, { fetchImpl });

    const token = await runtime.getValidToken("notion");

    expect(token).toBe("access-current");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes and persists a new access token when the current one is near expiry", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({
      access_token: "access-refreshed",
      refresh_token: "refresh-rotated",
      expires_in: 3600,
      token_type: "Bearer",
    }));
    const { runtime, getConfig } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000, // inside the 60s pre-expiry window
      },
    }, { fetchImpl });

    const token = await runtime.getValidToken("notion");

    expect(token).toBe("access-refreshed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const saved = getConfig().connectors[0];
    expect(saved.oauth.accessToken).toBe("access-refreshed");
    expect(saved.oauth.refreshToken).toBe("refresh-rotated");
  });

  it("does NOT stop the connector when writing back a refreshed token", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({
      access_token: "access-refreshed",
      expires_in: 3600,
      token_type: "Bearer",
    }));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });
    const stopSpy = vi.spyOn(runtime, "stopConnector");

    await runtime.getValidToken("notion");

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent refreshes for the same connector into one token request", async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => {
      resolveFetch = () => resolve(tokenResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
        token_type: "Bearer",
      }));
    }));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    // Three callers race in while the token is near-expiry.
    const p1 = runtime.getValidToken("notion");
    const p2 = runtime.getValidToken("notion");
    const p3 = runtime.getValidToken("notion");
    resolveFetch();
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

    // Exactly one network refresh despite three concurrent callers.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(t1).toBe("access-refreshed");
    expect(t2).toBe("access-refreshed");
    expect(t3).toBe("access-refreshed");
  });

  it("clears the in-flight refresh so a later near-expiry triggers a fresh refresh", async () => {
    // A short-lived token (30s) lands back inside the 60s pre-expiry window, so
    // the next getValidToken is still near-expiry and must refresh again. This
    // only happens if the in-flight dedup map was cleared after the first refresh.
    const fetchImpl = vi.fn(async () => tokenResponse({
      access_token: "access-refreshed",
      refresh_token: "refresh-rotated",
      expires_in: 30,
      token_type: "Bearer",
    }));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    await runtime.getValidToken("notion");
    await runtime.getValidToken("notion");

    // Two sequential near-expiry calls => two refreshes (in-flight map cleared between them).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the existing token without refreshing when there is no refresh token", async () => {
    const fetchImpl = vi.fn();
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-current",
        refreshToken: "",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    const token = await runtime.getValidToken("notion");

    expect(token).toBe("access-current");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // #1286 ③a I1: when the refresh token itself is dead, the token endpoint returns
  // 400 invalid_grant. Both refresh entry points (force-refresh on 401, and the
  // pre-request near-expiry refresh) must surface a STRUCTURED auth-terminal error
  // so the http-client/runtime classify it as needs-auth instead of a transient
  // failure that loops backoff and re-hammers the AS with a dead refresh token.
  it("propagates an auth-terminal McpHttpError from refreshIfPossible when the refresh token is dead", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-dead",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    const err = await runtime.refreshIfPossible("notion").catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(400);
    expect(err.oauthError).toBe("invalid_grant");
  });

  it("propagates an auth-terminal McpHttpError from getValidToken pre-refresh when the refresh token is dead", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-dead",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000, // inside the pre-expiry window ??triggers refresh
      },
    }, { fetchImpl });

    const err = await runtime.getValidToken("notion").catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.oauthError).toBe("invalid_grant");
  });
});

describe("MCP runtime OAuth persistence", () => {
  it("persists DCR client id, secret, and source when completing OAuth", async () => {
    let current = {
      enabled: true,
      connectors: [{ id: "notion", name: "Notion", url: "https://mcp.example.com/mcp", authType: "oauth" }],
    };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-dcr-test",
      config: {
        get: vi.fn(() => current),
        set: vi.fn((_key, value) => { current = { ...current, ...value }; }),
      },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    // Seed a pending OAuth session as if DCR had produced these products.
    runtime.oauthSessions.set("state-1", {
      status: "pending",
      state: "state-1",
      connectorId: "notion",
      connectorUrl: "https://mcp.example.com/mcp",
      clientId: "dcr-client",
      clientSecret: "dcr-secret",
      clientIdSource: "dcr",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      codeVerifier: "verifier-1",
      tokenEndpoint: "https://auth.example.com/token",
      scope: "files:read offline_access",
      resource: "https://mcp.example.com/mcp",
    });

    // Stub the token exchange via fetchImpl by pointing the runtime's fetch at a fake.
    runtime.fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      token_type: "Bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await runtime.completeOAuth({ state: "state-1", code: "code-1" });

    const saved = current.connectors[0];
    expect(saved.oauthClientId).toBe("dcr-client");
    expect(saved.oauthClientSecret).toBe("dcr-secret");
    expect(saved.clientIdSource).toBe("dcr");
    expect(saved.oauth.accessToken).toBe("access-1");
    expect(saved.oauth.refreshToken).toBe("refresh-1");
  });

  it("defaults clientIdSource to manual for legacy connectors that already have a client id", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        { id: "legacy-oauth", url: "https://mcp.example.com/mcp", authType: "oauth", oauthClientId: "old-client" },
        { id: "no-client", url: "https://mcp.example.com/mcp", authType: "oauth" },
      ],
    });

    expect(config.connectors[0].clientIdSource).toBe("manual");
    expect(config.connectors[1].clientIdSource).toBe("");
  });

  it("preserves an explicit clientIdSource of dcr through normalization", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        { id: "auto", url: "https://mcp.example.com/mcp", authType: "oauth", oauthClientId: "auto-client", clientIdSource: "dcr" },
      ],
    });

    expect(config.connectors[0].clientIdSource).toBe("dcr");
  });

  it("never leaks the refresh token or DCR client secret through public state", () => {
    const stored = {
      enabled: true,
      connectors: [{
        id: "notion",
        name: "Notion",
        url: "https://mcp.example.com/mcp",
        authType: "oauth",
        oauthClientId: "dcr-client",
        oauthClientSecret: "super-secret-dcr",
        clientIdSource: "dcr",
        oauth: {
          accessToken: "AT-do-not-leak",
          refreshToken: "RT-do-not-leak",
          scope: "files:read offline_access",
          expiresAt: Date.now() + 3_600_000,
          tokenEndpoint: "https://auth.example.com/token",
        },
      }],
    };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-leak-test",
      config: { get: vi.fn(() => stored), set: vi.fn() },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: console,
    });

    const serialized = JSON.stringify(runtime.getState());
    expect(serialized).not.toContain("AT-do-not-leak");
    expect(serialized).not.toContain("RT-do-not-leak");
    expect(serialized).not.toContain("super-secret-dcr");

    const [connector] = runtime.getState().connectors;
    // Provenance is safe to expose (drives UI), the secret is masked.
    expect(connector.clientIdSource).toBe("dcr");
    expect(connector.oauthClientSecret).toBe("********");
    // The oauth view exposes only connection status, never raw tokens.
    expect(connector.oauth).toEqual({
      connected: true,
      scope: "files:read offline_access",
      expiresAt: stored.connectors[0].oauth.expiresAt,
    });
  });
});
