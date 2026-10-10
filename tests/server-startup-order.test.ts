import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readServerEntry() {
  return fs.readFileSync(path.join(process.cwd(), "server", "index.ts"), "utf8");
}

describe("server startup order", () => {
  it("uses persisted server network settings as the default listen target", () => {
    const source = readServerEntry();

    expect(source).toContain('import { resolveServerListenOptions } from "../core/server-network-config.ts";');
    expect(source).toContain("const serverNetwork = resolveServerListenOptions(codiaHome);");
    expect(source).toMatch(/const port = Number\.isInteger\(envPort\) && envPort >= 0 \? envPort : serverNetwork\.port;/);
    expect(source).toContain("const host = serverNetwork.host;");
    expect(source).not.toContain("const port = parseInt(process.env.CODIA_PORT) || 0;");
    expect(source).not.toContain("resolveWebAccessBindHost(engine.preferences?.getWebAccess?.())");
  });

  it("claims the HTTP port before heavy startup side effects", () => {
    const source = readServerEntry();

    const bindIdx = source.indexOf("await bindServerTransportOwnership(server");
    const ensureFirstRunIdx = source.indexOf("ensureFirstRun(codiaHome");
    const engineCreateIdx = source.indexOf("new CodiaEngine");

    expect(source).toContain('import { createAdaptorServer } from "@hono/node-server";');
    expect(source).toMatch(/let activeFetch(?::\s*ServerFetchCallback)?\s*=\s*\(request\)\s*=>/);
    expect(source).toContain("activeFetch = app.fetch.bind(app);");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(ensureFirstRunIdx).toBeGreaterThan(-1);
    expect(engineCreateIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeLessThan(ensureFirstRunIdx);
    expect(bindIdx).toBeLessThan(engineCreateIdx);
    expect(source).not.toContain("serve({ fetch: app.fetch");
  });

  it("creates the default session only after plugins and extension factories are registered", () => {
    const source = readServerEntry();

    const initPluginsIdx = source.indexOf("await engine.initPlugins(hub.eventBus);");
    const deferredExtIdx = source.indexOf(
      "engine.registerExtensionFactory(createDeferredResultExtension(deferredResultStore));",
    );
    const startupMarkerIdx = source.indexOf(
      'console.log("[server] creating default session after plugins/extensions init...");',
    );
    const createSessionIdx = source.indexOf("await engine.createSession(", startupMarkerIdx);

    expect(initPluginsIdx).toBeGreaterThan(-1);
    expect(deferredExtIdx).toBeGreaterThan(-1);
    expect(startupMarkerIdx).toBeGreaterThan(-1);
    expect(createSessionIdx).toBeGreaterThan(-1);

    expect(startupMarkerIdx).toBeGreaterThan(initPluginsIdx);
    expect(startupMarkerIdx).toBeGreaterThan(deferredExtIdx);
    expect(createSessionIdx).toBeGreaterThan(initPluginsIdx);
    expect(createSessionIdx).toBeGreaterThan(deferredExtIdx);
  });

  it("keeps the health endpoint useful for server-first clients", () => {
    const source = readServerEntry();

    expect(source).toContain("version: appVersion");
    expect(source).toContain("agentId: engine.currentAgentId || null");
    expect(source).toContain('agentYuan: engine.agent?.config?.agent?.yuan || "codia"');
  });

  it("emits structured listen permission startup errors", () => {
    const source = readServerEntry();

    expect(source).toMatch(/function isListenPermissionError\(err(?::\s*unknown)?\)/);
    expect(source).toContain('return getErrorCode(err) === "EACCES";');
    expect(source).toContain("createListenPermissionStartupError(err, { host, port, listenHost, networkMode })");
    expect(source).toContain('code: "LISTEN_PERMISSION_DENIED"');
    expect(source).toContain("startupError.startupPayload");
  });

  it("injects stable session id resolution into subagent lifecycle stores", () => {
    const source = readServerEntry();
    const runStoreIdx = source.indexOf("const subagentRunStore = new SubagentRunStore(");
    const threadStoreIdx = source.indexOf("const subagentThreadStore = new SubagentThreadStore(");
    const runStoreBlock = source.slice(runStoreIdx, source.indexOf("engine.setSubagentRunStore", runStoreIdx));
    const threadStoreBlock = source.slice(threadStoreIdx, source.indexOf("engine.setSubagentThreadStore", threadStoreIdx));

    expect(runStoreIdx).toBeGreaterThan(-1);
    expect(threadStoreIdx).toBeGreaterThan(-1);
    expect(runStoreBlock).toContain('path.join(codiaHome, "subagent-runs.json")');
    expect(runStoreBlock).toContain("getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null");
    expect(threadStoreBlock).toContain('path.join(codiaHome, "subagent-threads.json")');
    expect(threadStoreBlock).toContain("getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null");
  });

  it("injects stable session id resolution into activity and browser runtime state", () => {
    const source = readServerEntry();
    const activityHubIdx = source.indexOf("const activityHub = new ActivityHub(");
    const activityHubBlock = source.slice(activityHubIdx, source.indexOf("engine.setActivityHub", activityHubIdx));

    expect(source).toContain("BrowserManager.setSessionIdResolver((sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null);");
    expect(activityHubIdx).toBeGreaterThan(-1);
    expect(activityHubBlock).toContain("workflowActivityStore");
    expect(activityHubBlock).toContain("getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null");
  });
});
