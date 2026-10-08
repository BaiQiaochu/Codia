// @ts-nocheck
/**
  *
 *
  * */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpRuntime } from "../plugins/mcp/lib/mcp-runtime.js";
import { McpHttpError } from "../plugins/mcp/lib/mcp-http-client.js";

/**
  *
  * */
function makeFakeClientFactory() {
  const instances = [];
  let nextStartError = null;
  let persistentStartError = null;
  const factory = (connector, opts) => {
    const client = {
      connector,
      opts,
      running: false,
      startCalls: 0,
      stopCalls: 0,
      listToolsCalls: 0,
      start: vi.fn(async () => {
        client.startCalls += 1;
        if (persistentStartError) {
          throw persistentStartError;
        }
        if (nextStartError) {
          const err = nextStartError;
          nextStartError = null;
          throw err;
        }
        client.running = true;
      }),
      stop: vi.fn(async () => {
        client.stopCalls += 1;
        client.running = false;
      }),
      listTools: vi.fn(async () => {
        client.listToolsCalls += 1;
        return [];
      }),
      callTool: vi.fn(async () => ({ content: [] })),
      // Simulate the transport reporting an unexpected disconnect.
      emitUnexpectedClose(reason = "stream closed") {
        client.running = false;
        opts.onClose?.({ reason, expected: false });
      },
      emitExpectedClose(reason = "stopped") {
        client.running = false;
        opts.onClose?.({ reason, expected: true });
      },
      // Simulate a transport reporting a 401/403 auth loss on a live session.
      emitNeedsAuthClose(reason = "authentication required") {
        client.running = false;
        opts.onClose?.({ reason, expected: false, needsAuth: true });
      },
    };
    instances.push(client);
    return client;
  };
  factory.instances = instances;
  factory.failNextStart = (err) => { nextStartError = err; };
  factory.failAllStarts = (err) => { persistentStartError = err; };
  return factory;
}

function makeRuntime(stored, factory) {
  let current = stored;
  const runtime = new McpRuntime({
    dataDir: "/tmp/mcp-reconnect-test",
    config: {
      get: vi.fn(() => current),
      set: vi.fn((_key, value) => {
        // Mirror saveConfig semantics so getConfig() reflects writes.
        current = { ...current, ...value };
      }),
    },
    registerTool: vi.fn(() => () => {}),
    bus: { request: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }, { clientFactory: factory });
  return runtime;
}

const STDIO_CONNECTOR = {
  id: "local",
  name: "Local",
  command: "npx",
  args: ["-y", "mcp-server"],
};

describe("MCP runtime auto-reconnect", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reconnects after an unexpected disconnect while desiredState is running", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    expect(factory.instances).toHaveLength(1);
    const first = factory.instances[0];
    expect(first.running).toBe(true);

    // Transport dies unexpectedly (e.g. stdio child exited, SSE stream ended).
    first.emitUnexpectedClose("child exited");

    // First backoff tick (1s) should build a fresh client and reconnect.
    await vi.advanceTimersByTimeAsync(1000);

    expect(factory.instances).toHaveLength(2);
    const second = factory.instances[1];
    expect(second.startCalls).toBe(1);
    expect(second.listToolsCalls).toBe(1);
    expect(runtime.clients.get("local")).toBe(second);
    expect(runtime.getState().connectors[0].status).toBe("running");

    await runtime.dispose();
  });

  it("does NOT reconnect after a user-initiated stop (desiredState=stopped)", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // User explicitly stops the connector.
    await runtime.stopConnector("local");
    // A close event arriving from the now-stopped client must be ignored.
    first.emitExpectedClose("stopped by user");

    // Even if some stray unexpected close races in after stop, intent gating wins.
    first.emitUnexpectedClose("late race");

    await vi.advanceTimersByTimeAsync(60_000);

    //
    expect(factory.instances).toHaveLength(1);
    expect(runtime.clients.has("local")).toBe(false);
    expect(runtime.getState().connectors[0].status).toBe("stopped");

    await runtime.dispose();
  });

  it("does NOT reconnect when MCP is globally disabled even if a close fires", async () => {
    const factory = makeFakeClientFactory();
    const stored = { enabled: true, connectors: [STDIO_CONNECTOR] };
    const runtime = makeRuntime(stored, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // Globally disable MCP (this also stops connectors, flipping desiredState).
    await runtime.setEnabled(false);
    first.emitUnexpectedClose("after global disable");

    await vi.advanceTimersByTimeAsync(60_000);

    expect(factory.instances).toHaveLength(1);
    expect(runtime.clients.has("local")).toBe(false);

    await runtime.dispose();
  });

  it("uses exponential backoff (1s, 2s, 4s) across repeated reconnect failures", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // Reconnect attempt #1 fails.
    factory.failNextStart(new Error("connect refused"));
    first.emitUnexpectedClose("dead");

    // Nothing before 1s.
    await vi.advanceTimersByTimeAsync(999);
    expect(factory.instances).toHaveLength(1);
    // At 1s, attempt #1 runs and fails.
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.instances).toHaveLength(2);
    expect(runtime.getState().connectors[0].status).toBe("reconnecting");

    // Attempt #2 should be scheduled at +2s. Make it fail too.
    factory.failNextStart(new Error("still refused"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(factory.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.instances).toHaveLength(3);

    // Attempt #3 should be scheduled at +4s. Let it succeed.
    await vi.advanceTimersByTimeAsync(3999);
    expect(factory.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.instances).toHaveLength(4);
    expect(factory.instances[3].running).toBe(true);
    expect(runtime.getState().connectors[0].status).toBe("running");

    await runtime.dispose();
  });

  it("marks the connector failed after exceeding the reconnect attempt cap and stops retrying", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // The server is permanently down: every reconnect attempt fails.
    factory.failAllStarts(new Error("permanently down"));
    first.emitUnexpectedClose("dead for good");

    // Drive well past the cap (backoff tops out at 30s; advance 30s per tick).
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    const state = runtime.getState().connectors[0];
    expect(state.status).toBe("failed");
    //
    expect(state.error).toContain("permanently down");

    const createdAfterFailure = factory.instances.length;
    //
    await vi.advanceTimersByTimeAsync(600_000);
    expect(factory.instances.length).toBe(createdAfterFailure);

    await runtime.dispose();
  });

  it("does not reconnect a connector whose autoReconnect is false", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({
      enabled: true,
      connectors: [{ ...STDIO_CONNECTOR, autoReconnect: false }],
    }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];
    first.emitUnexpectedClose("died");

    await vi.advanceTimersByTimeAsync(60_000);

    expect(factory.instances).toHaveLength(1);
    // With reconnect disabled, an unexpected death surfaces as stopped (not running, not reconnecting).
    expect(runtime.getState().connectors[0].status).toBe("stopped");

    await runtime.dispose();
  });

  it("ignores a late close event from an already-replaced client (no double reconnect)", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // First death triggers a reconnect that succeeds at the 1s tick.
    first.emitUnexpectedClose("first death");
    await vi.advanceTimersByTimeAsync(1000);
    expect(factory.instances).toHaveLength(2);
    const second = factory.instances[1];
    expect(runtime.clients.get("local")).toBe(second);
    expect(runtime.getState().connectors[0].status).toBe("running");

    // A delayed close from the ALREADY-REPLACED first client must be ignored:
    // it is no longer the active client, so it cannot tear down the live one
    // or spawn a competing reconnect.
    first.emitUnexpectedClose("stale late death");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(factory.instances).toHaveLength(2);
    expect(runtime.clients.get("local")).toBe(second);
    expect(runtime.getState().connectors[0].status).toBe("running");

    await runtime.dispose();
  });

  it("clears any pending reconnect when the user stops mid-backoff", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    factory.failNextStart(new Error("flaky"));
    first.emitUnexpectedClose("dropped");
    // We're now in backoff (reconnecting). User stops before the timer fires.
    await vi.advanceTimersByTimeAsync(500);
    await runtime.stopConnector("local");

    await vi.advanceTimersByTimeAsync(60_000);

    // The scheduled reconnect must have been cancelled by the stop.
    expect(factory.instances).toHaveLength(1);
    expect(runtime.clients.has("local")).toBe(false);
    expect(runtime.getState().connectors[0].status).toBe("stopped");

    await runtime.dispose();
  });
});

describe("MCP runtime establishing-phase suppression", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not start a reconnect loop when a client dies during its initial manual start", async () => {
    // A client whose start() both throws AND fires onClose mid-start, modelling
    // a stdio child that exits during initialize (death reported via two paths).
    const instances = [];
    const factory = (connector, opts) => {
      const client = {
        running: false,
        start: vi.fn(async () => {
          // Report the death the way a stdio exit handler would, then reject.
          opts.onClose?.({ reason: "child exited during init", expected: false });
          throw new Error("initialize failed: child exited");
        }),
        stop: vi.fn(async () => { client.running = false; }),
        listTools: vi.fn(async () => []),
        callTool: vi.fn(),
      };
      instances.push(client);
      return client;
    };
    factory.instances = instances;

    let current = { enabled: true, connectors: [{ ...STDIO_CONNECTOR }] };
    const runtime = new McpRuntime({
      dataDir: "/tmp/mcp-establishing-test",
      config: { get: () => current, set: (_k, v) => { current = { ...current, ...v }; } },
      registerTool: vi.fn(() => () => {}),
      bus: { request: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }, { clientFactory: factory });

    // Manual start fails (the error propagates to the caller as before).
    await expect(runtime.startConnector("local")).rejects.toThrow(/child exited/);

    //
    // failed *initial* start is not an unexpected disconnect of a live session,
    // so no backoff reconnect loop is armed.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(instances).toHaveLength(1);
    expect(runtime.clients.has("local")).toBe(false);
    expect(runtime.getState().connectors[0].status).toBe("stopped");

    await runtime.dispose();
  });
});

describe("MCP connector config normalization (autoReconnect)", () => {
  it("defaults autoReconnect to true for legacy connectors without the field", () => {
    const runtime = makeRuntime({
      enabled: true,
      connectors: [{ id: "legacy", command: "npx" }],
    }, makeFakeClientFactory());
    const connector = runtime.getConfig().connectors[0];
    expect(connector.autoReconnect).toBe(true);
  });

  it("preserves an explicit autoReconnect=false", () => {
    const runtime = makeRuntime({
      enabled: true,
      connectors: [{ id: "manual", command: "npx", autoReconnect: false }],
    }, makeFakeClientFactory());
    const connector = runtime.getConfig().connectors[0];
    expect(connector.autoReconnect).toBe(false);
  });
});

// Auth-terminal reconnect handling.
describe("MCP runtime needs-auth handling during reconnect", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("marks needs-auth and arms no reconnect when a live client dies with a 401", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // The live session dies with a 401 (token revoked server-side). This must
    //
    // same invalid credentials is futile; the OAuth self-heal / re-auth handles it.
    first.emitNeedsAuthClose("token revoked");

    expect(runtime.getState().connectors[0].status).toBe("needs-auth");

    await vi.advanceTimersByTimeAsync(120_000);
    //
    expect(factory.instances).toHaveLength(1);
    expect(runtime.clients.has("local")).toBe(false);

    await runtime.dispose();
  });

  it("cancels an in-flight backoff when a reconnect attempt then reports needs-auth", async () => {
    // Reachable path that exercises the needs-auth _cancelReconnect: a transient
    // drop arms backoff; the reconnect attempt establishes a fresh live client;
    // that client immediately dies with a 401. The needs-auth handler must cancel
    // the (now stale) reconnect bookkeeping and not keep retrying.
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    first.emitUnexpectedClose("dropped");
    await vi.advanceTimersByTimeAsync(1000); // attempt #1 builds a fresh live client
    const second = factory.instances[1];
    expect(runtime.clients.get("local")).toBe(second);
    expect(runtime.getState().connectors[0].status).toBe("running");

    // The freshly reconnected client now hits a 401.
    second.emitNeedsAuthClose("token revoked after reconnect");
    expect(runtime.getState().connectors[0].status).toBe("needs-auth");

    const countAtAuthLoss = factory.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(factory.instances.length).toBe(countAtAuthLoss);

    await runtime.dispose();
  });

  it("short-circuits to needs-auth (not failed) when a reconnect attempt hits a 401", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // The reconnect attempt itself fails with an auth error (token expired while
    // the connection was down). This must NOT be treated as a generic failure
    //
    factory.failNextStart(new McpHttpError("unauthorized", { status: 401 }));
    first.emitUnexpectedClose("dropped");

    await vi.advanceTimersByTimeAsync(1000); // attempt #1 fires and hits 401

    expect(runtime.getState().connectors[0].status).toBe("needs-auth");

    const countAfter401 = factory.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);
    // No backoff continuation after the auth error.
    expect(factory.instances.length).toBe(countAfter401);

    await runtime.dispose();
  });

  // #1286 I1: when the dead credential surfaces as a 400 invalid_grant (the
  // refresh token itself expired, not a raw 401), the reconnect attempt must STILL
  //
  // off ~8 times re-hammering the token endpoint with a dead refresh token.
  it("short-circuits to needs-auth when a reconnect attempt fails with invalid_grant (status 400)", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // The reconnect's pre-request refresh dies because the refresh token is dead.
    factory.failNextStart(new McpHttpError("OAuth token refresh failed: refresh token expired", {
      status: 400,
      oauthError: "invalid_grant",
    }));
    first.emitUnexpectedClose("dropped");

    await vi.advanceTimersByTimeAsync(1000); // attempt #1 fires and hits invalid_grant

    expect(runtime.getState().connectors[0].status).toBe("needs-auth");

    const countAfterAuthDeath = factory.instances.length;
    // Drive well past the whole backoff budget: NOT a single extra attempt.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(factory.instances.length).toBe(countAfterAuthDeath);

    await runtime.dispose();
  });

  // #1286 I1 (counter-case): a transient reconnect failure (network drop / 5xx,
  // no auth-terminal signal) must keep backing off, not collapse to needs-auth.
  it("keeps backing off (not needs-auth) when a reconnect attempt fails transiently", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // A 5xx during reconnect is transient: retrying may succeed.
    factory.failNextStart(new McpHttpError("gateway down", { status: 503 }));
    first.emitUnexpectedClose("dropped");

    await vi.advanceTimersByTimeAsync(1000); // attempt #1 fires and hits 503

    //
    expect(runtime.getState().connectors[0].status).toBe("reconnecting");
    // The next backoff tick builds another client (proving it kept retrying).
    await vi.advanceTimersByTimeAsync(2000);
    expect(factory.instances.length).toBeGreaterThan(2);

    await runtime.dispose();
  });

  // #1286 M1: "needs re-auth" is a credential fact, orthogonal to the keepalive
  // preference. A connector with autoReconnect=false that loses auth must STILL
  // surface needs-auth (consistent with the reconnect-attempt path), not silently
  //
  it("marks needs-auth on auth loss even when autoReconnect is false", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({
      enabled: true,
      connectors: [{ ...STDIO_CONNECTOR, autoReconnect: false }],
    }, factory);

    await runtime.startConnector("local");
    const first = factory.instances[0];

    // The live session dies with a 401 on a connector the user opted out of
    // auto-reconnect. needs-auth is about credentials, not keepalive.
    first.emitNeedsAuthClose("token revoked");

    expect(runtime.getState().connectors[0].status).toBe("needs-auth");

    // Still no reconnect (autoReconnect=false means we don't retry), but the
    // status reflects the credential reality so the user can re-auth.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(factory.instances).toHaveLength(1);
    expect(runtime.clients.has("local")).toBe(false);

    await runtime.dispose();
  });

  it("injects getAuthToken/refreshAuthToken into the client it builds", async () => {
    const factory = makeFakeClientFactory();
    const runtime = makeRuntime({ enabled: true, connectors: [STDIO_CONNECTOR] }, factory);

    await runtime.startConnector("local");
    const client = factory.instances[0];

    // The runtime must wire the OAuth self-heal seams so config refreshes reach
    // the live client and 401s can force a refresh.
    expect(typeof client.opts.getAuthToken).toBe("function");
    expect(typeof client.opts.refreshAuthToken).toBe("function");

    await runtime.dispose();
  });
});
