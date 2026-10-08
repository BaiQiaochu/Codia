import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { RcStateStore } from "../core/slash-commands/rc-state.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import { SubagentRunStore } from "../lib/subagent-run-store.ts";
import { TaskRegistry } from "../lib/task-registry.ts";

const browserMock = vi.hoisted(() => ({
  isRunning: vi.fn(() => false),
  currentUrl: vi.fn(() => null),
  suspendForSession: vi.fn(),
  resumeForSession: vi.fn(),
  closeBrowserForSession: vi.fn(),
  getBrowserSessions: vi.fn(() => ({})),
  getBrowserSessionStates: vi.fn(() => ({})),
  get hasAnyRunning() { return false; },
}));

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => browserMock,
  },
}));

vi.mock("../core/message-utils.js", async () => {
  const actual = await vi.importActual("../core/message-utils.js");
  return {
    ...actual,
    extractTextContent: vi.fn(() => ({ text: "", images: [], thinking: "", toolUses: [] })),
    loadSessionHistoryMessages: vi.fn(async () => []),
  };
});

function makeEngine(tmpDir) {
  return {
    agentsDir: path.join(tmpDir, "agents"),
    closeSession: vi.fn(async () => {}),
    setSessionPinned: vi.fn(async () => null),
    agentIdFromSessionPath: (p) => {
      const rel = path.relative(path.join(tmpDir, "agents"), p);
      return rel.split(path.sep)[0] || null;
    },
    getAgent: () => ({ agentName: "G-SAP" }),
    clearSessionTitle: vi.fn(async () => {}),
    listArchivedSessions: vi.fn(async () => []),
    emitEvent: vi.fn(),
    rcState: new RcStateStore(),
    discardSessionRuntime: vi.fn(async () => false),
    switchSession: vi.fn(async () => {}),
    getSessionByPath: vi.fn(() => ({ messages: [] })),
    currentSessionPath: null,
    currentAgentId: "a",
    activeSessionModel: null,
    currentModel: null,
    planMode: false,
    permissionMode: "operate",
    accessMode: "operate",
    getSessionWorkspaceFolders: vi.fn(() => []),
    getSessionThinkingLevel: vi.fn(() => "medium"),
    isSessionStreaming: vi.fn(() => false),
    getSessionIdForPath: vi.fn(() => null),
    moveSessionLifecycle: vi.fn(async (input) => ({
      sessionId: "sess_a",
      lifecycle: input.lifecycle,
      currentLocator: { path: input.toPath },
    })),
  };
}

describe("archive route: mtime semantics", () => {
  let tmpDir, engine, app;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-archived-"));
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    const sess = path.join(sessDir, "s1.jsonl");
    fs.writeFileSync(sess, "{}\n");
    // 把文件 mtime 设回 180 天前，模拟老对话
    const oldTs = (Date.now() - 180 * 86400_000) / 1000;
    fs.utimesSync(sess, oldTs, oldTs);

    engine = makeEngine(tmpDir);
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("sets archived file mtime to now (not the old activity time)", async () => {
    const src = path.join(tmpDir, "agents", "a", "sessions", "s1.jsonl");
    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });
    expect(res.status).toBe(200);
    const dest = path.join(tmpDir, "agents", "a", "sessions", "archived", "s1.jsonl");
    const stat = await fsp.stat(dest);
    const ageMs = Date.now() - stat.mtime.getTime();
    expect(ageMs).toBeLessThan(5000);
  });

  it("moves the stage file sidecar together with the archived session", async () => {
    const src = path.join(tmpDir, "agents", "a", "sessions", "s1.jsonl");
    const sidecar = `${src}.files.json`;
    fs.writeFileSync(sidecar, JSON.stringify({ version: 1, sessionPath: src, files: {}, refs: [] }));

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });

    const dest = path.join(tmpDir, "agents", "a", "sessions", "archived", "s1.jsonl");
    expect(res.status).toBe(200);
    expect(fs.existsSync(sidecar)).toBe(false);
    expect(fs.existsSync(`${dest}.files.json`)).toBe(true);
  });

  it("moves the session manifest to archived lifecycle before archiving the file", async () => {
    const src = path.join(tmpDir, "agents", "a", "sessions", "s1.jsonl");
    const dest = path.join(tmpDir, "agents", "a", "sessions", "archived", "s1.jsonl");

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });

    expect(res.status).toBe(200);
    expect(engine.moveSessionLifecycle).toHaveBeenCalledWith({
      fromPath: src,
      toPath: dest,
      lifecycle: "archived",
      reason: "session_archive",
    });
  });

  it("discards active and future archived runtime state before moving the session", async () => {
    const src = path.join(tmpDir, "agents", "a", "sessions", "s1.jsonl");
    const dest = path.join(tmpDir, "agents", "a", "sessions", "archived", "s1.jsonl");

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });

    expect(res.status).toBe(200);
    expect(engine.discardSessionRuntime).toHaveBeenCalledWith(src, "parent session archived", { skipMemory: true });
    expect(engine.discardSessionRuntime).toHaveBeenCalledWith(dest, "parent session archived", { skipMemory: true });
  });

  it("invalidates rc attachment and pending that point at the archived session", async () => {
    const src = path.join(tmpDir, "agents", "a", "sessions", "s1.jsonl");
    engine.rcState.attach("tg_dm_owner@a", src);
    engine.rcState.setPending("tg_dm_other@a", {
      type: "rc-select",
      promptText: "menu",
      options: [{ path: src, title: "S1" }],
    });

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });

    expect(res.status).toBe(200);
    expect(engine.rcState.isAttached("tg_dm_owner@a")).toBe(false);
    expect(engine.rcState.isPending("tg_dm_other@a")).toBe(false);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bridge_rc_detached",
        sessionKey: "tg_dm_owner@a",
        sessionPath: src,
      }),
      src,
    );
  });

  it("aborts parent tasks and suppresses deferred delivery before moving the active session", async () => {
    const src = path.join(tmpDir, "agents", "a", "sessions", "s1.jsonl");
    const dest = path.join(tmpDir, "agents", "a", "sessions", "archived", "s1.jsonl");
    const abortSubagent = vi.fn();
    engine.taskRegistry = new TaskRegistry();
    engine.taskRegistry.registerHandler("subagent", { abort: abortSubagent });
    engine.taskRegistry.register("subagent-running", { type: "subagent", parentSessionPath: src });

    engine.deferredResults = new (DeferredResultStore as any)();
    engine.deferredResults.defer("pending-active", src, { type: "subagent" });
    engine.deferredResults.defer("resolved-active", src, { type: "subagent" });
    engine.deferredResults.resolve("resolved-active", "done");
    engine.deferredResults.defer("pending-archived-key", dest, { type: "subagent" });

    engine.subagentRuns = new (SubagentRunStore as any)();
    engine.subagentRuns.register("subagent-running", { parentSessionPath: src });

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    });

    expect(res.status).toBe(200);
    expect(abortSubagent).toHaveBeenCalledWith("subagent-running");
    expect(engine.taskRegistry.query("subagent-running")).toMatchObject({
      status: "aborted",
      aborted: true,
    });
    expect(engine.deferredResults.query("pending-active")).toMatchObject({
      status: "aborted",
      delivered: true,
      deliverySuppressed: true,
    });
    expect(engine.deferredResults.query("resolved-active")).toMatchObject({
      status: "resolved",
      delivered: true,
      deliverySuppressed: true,
    });
    expect(engine.deferredResults.query("pending-archived-key")).toMatchObject({
      status: "aborted",
      delivered: true,
      deliverySuppressed: true,
    });
    expect(engine.subagentRuns.query("subagent-running")).toMatchObject({
      status: "aborted",
    });
    expect(browserMock.closeBrowserForSession).toHaveBeenCalledWith(src);
    expect(browserMock.closeBrowserForSession).toHaveBeenCalledWith(dest);
  });

  it("rejects an already archived path instead of creating archived/archived", async () => {
    const archivedDir = path.join(tmpDir, "agents", "a", "sessions", "archived");
    const archivedPath = path.join(archivedDir, "already.jsonl");
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(archivedPath, "{}\n");

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archivedPath }),
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, "archived", "already.jsonl"))).toBe(false);
  });
});

describe("POST /api/sessions/switch archived path", () => {
  let tmpDir, engine, app, archivedPath;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-switch-archived-"));
    const archivedDir = path.join(tmpDir, "agents", "a", "sessions", "archived");
    fs.mkdirSync(archivedDir, { recursive: true });
    archivedPath = path.join(archivedDir, "s1.jsonl");
    fs.writeFileSync(archivedPath, "{}\n");
    engine = makeEngine(tmpDir);
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("does not switch or cold-load an archived desktop session", async () => {
    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archivedPath }),
    });

    expect(res.status).toBe(403);
    expect(engine.switchSession).not.toHaveBeenCalled();
    expect(browserMock.resumeForSession).not.toHaveBeenCalled();
  });
});

describe("GET /api/sessions/archived", () => {
  let tmpDir, engine, app;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-archived-list-"));
    engine = makeEngine(tmpDir);
    engine.listArchivedSessions = vi.fn(async () => [
      {
        path: "/x/a1.jsonl",
        title: "Hi",
        archivedAt: "2026-04-22T00:00:00.000Z",
        sizeBytes: 1024,
        agentId: "a",
        agentName: "AgentA",
      },
    ]);
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("returns the engine-provided list", async () => {
    const res = await app.request("/api/sessions/archived");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].title).toBe("Hi");
    expect(body[0].sizeBytes).toBe(1024);
    expect(engine.listArchivedSessions).toHaveBeenCalled();
  });
});

describe("POST /api/sessions/restore", () => {
  let tmpDir, engine, app, archSrc, activeDest;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-restore-"));
    const archDir = path.join(tmpDir, "agents", "a", "sessions", "archived");
    fs.mkdirSync(archDir, { recursive: true });
    archSrc = path.join(archDir, "r1.jsonl");
    activeDest = path.join(tmpDir, "agents", "a", "sessions", "r1.jsonl");
    fs.writeFileSync(archSrc, "{}\n");
    engine = makeEngine(tmpDir);
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("moves archived file back to sessions/", async () => {
    const res = await app.request("/api/sessions/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archSrc }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(archSrc)).toBe(false);
    expect(fs.existsSync(activeDest)).toBe(true);
  });

  it("moves the session manifest back to active lifecycle after restore", async () => {
    const res = await app.request("/api/sessions/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archSrc }),
    });

    expect(res.status).toBe(200);
    expect(engine.moveSessionLifecycle).toHaveBeenCalledWith({
      fromPath: archSrc,
      toPath: activeDest,
      lifecycle: "active",
      reason: "session_restore",
    });
  });

  it("moves the stage file sidecar back with the restored session", async () => {
    fs.writeFileSync(`${archSrc}.files.json`, JSON.stringify({ version: 1, sessionPath: archSrc, files: {}, refs: [] }));

    const res = await app.request("/api/sessions/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archSrc }),
    });

    expect(res.status).toBe(200);
    expect(fs.existsSync(`${archSrc}.files.json`)).toBe(false);
    expect(fs.existsSync(`${activeDest}.files.json`)).toBe(true);
  });

  it("returns 409 when active destination exists", async () => {
    fs.writeFileSync(activeDest, "conflict\n");
    const res = await app.request("/api/sessions/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archSrc }),
    });
    expect(res.status).toBe(409);
    expect(fs.existsSync(archSrc)).toBe(true);
    expect(fs.readFileSync(activeDest, "utf-8")).toBe("conflict\n");
  });

  it("rejects path not under /archived/", async () => {
    const bogus = path.join(tmpDir, "agents", "a", "sessions", "notarchived.jsonl");
    fs.writeFileSync(bogus, "{}\n");
    const res = await app.request("/api/sessions/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: bogus }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/sessions/archived/delete", () => {
  let tmpDir, engine, app, archPath, activeKey;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-del-arch-"));
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    const archDir = path.join(sessDir, "archived");
    fs.mkdirSync(archDir, { recursive: true });
    archPath = path.join(archDir, "d1.jsonl");
    activeKey = path.join(sessDir, "d1.jsonl");
    fs.writeFileSync(archPath, "{}\n");
    engine = makeEngine(tmpDir);
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("unlinks the archived file and clears title orphan", async () => {
    fs.writeFileSync(`${archPath}.files.json`, JSON.stringify({ version: 1, sessionPath: archPath, files: {}, refs: [] }));

    const res = await app.request("/api/sessions/archived/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archPath }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(archPath)).toBe(false);
    expect(fs.existsSync(`${archPath}.files.json`)).toBe(false);
    expect(engine.clearSessionTitle).toHaveBeenCalledWith(activeKey);
  });

  it("discards active and archived runtime state before permanent delete", async () => {
    const res = await app.request("/api/sessions/archived/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archPath }),
    });

    expect(res.status).toBe(200);
    expect(engine.discardSessionRuntime).toHaveBeenCalledWith(activeKey, "parent session deleted");
    expect(engine.discardSessionRuntime).toHaveBeenCalledWith(archPath, "parent session deleted");
  });

  it("also invalidates stale rc state keyed by the original active session path", async () => {
    engine.rcState.attach("tg_dm_owner@a", activeKey);
    engine.rcState.setPending("tg_dm_other@a", {
      type: "rc-select",
      promptText: "menu",
      options: [{ path: activeKey, title: "D1" }],
    });

    const res = await app.request("/api/sessions/archived/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archPath }),
    });

    expect(res.status).toBe(200);
    expect(engine.rcState.isAttached("tg_dm_owner@a")).toBe(false);
    expect(engine.rcState.isPending("tg_dm_other@a")).toBe(false);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bridge_rc_detached",
        sessionKey: "tg_dm_owner@a",
        sessionPath: activeKey,
      }),
      activeKey,
    );
  });

  it("suppresses deferred delivery keyed by active or archived path before permanent delete", async () => {
    engine.deferredResults = new (DeferredResultStore as any)();
    engine.deferredResults.defer("pending-active", activeKey, { type: "subagent" });
    engine.deferredResults.defer("resolved-archived", archPath, { type: "subagent" });
    engine.deferredResults.resolve("resolved-archived", "done");

    const res = await app.request("/api/sessions/archived/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: archPath }),
    });

    expect(res.status).toBe(200);
    expect(engine.deferredResults.query("pending-active")).toMatchObject({
      status: "aborted",
      delivered: true,
      deliverySuppressed: true,
    });
    expect(engine.deferredResults.query("resolved-archived")).toMatchObject({
      status: "resolved",
      delivered: true,
      deliverySuppressed: true,
    });
  });

  it("rejects non-archived path", async () => {
    const bogus = path.join(tmpDir, "agents", "a", "sessions", "active.jsonl");
    fs.writeFileSync(bogus, "{}\n");
    const res = await app.request("/api/sessions/archived/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: bogus }),
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(bogus)).toBe(true);
  });
});

describe("POST /api/sessions/cleanup (titles orphan cleanup)", () => {
  let tmpDir, engine, app;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cleanup-titles-"));
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    const archDir = path.join(sessDir, "archived");
    fs.mkdirSync(archDir, { recursive: true });
    const oldFile = path.join(archDir, "old.jsonl");
    fs.writeFileSync(oldFile, "{}\n");
    const oldTs = (Date.now() - 100 * 86400_000) / 1000;
    fs.utimesSync(oldFile, oldTs, oldTs);

    engine = makeEngine(tmpDir);
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("clears titles entries for deleted archived sessions", async () => {
    const oldFile = path.join(tmpDir, "agents", "a", "sessions", "archived", "old.jsonl");
    fs.writeFileSync(`${oldFile}.files.json`, JSON.stringify({ version: 1, sessionPath: oldFile, files: {}, refs: [] }));

    const res = await app.request("/api/sessions/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxAgeDays: 90 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(1);
    expect(fs.existsSync(`${oldFile}.files.json`)).toBe(false);
    const activeKey = path.join(tmpDir, "agents", "a", "sessions", "old.jsonl");
    expect(engine.clearSessionTitle).toHaveBeenCalledWith(activeKey);
  });

  it("removes deleted archived sessions during cleanup", async () => {
    const oldFile = path.join(tmpDir, "agents", "a", "sessions", "archived", "old.jsonl");

    const res = await app.request("/api/sessions/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxAgeDays: 90 }),
    });

    expect(res.status).toBe(200);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it("also invalidates stale rc state that still points at the deleted active path", async () => {
    const activeKey = path.join(tmpDir, "agents", "a", "sessions", "old.jsonl");
    engine.rcState.attach("tg_dm_owner@a", activeKey);
    engine.rcState.setPending("tg_dm_other@a", {
      type: "rc-select",
      promptText: "menu",
      options: [{ path: activeKey, title: "old" }],
    });

    const res = await app.request("/api/sessions/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxAgeDays: 90 }),
    });

    expect(res.status).toBe(200);
    expect(engine.rcState.isAttached("tg_dm_owner@a")).toBe(false);
    expect(engine.rcState.isPending("tg_dm_other@a")).toBe(false);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bridge_rc_detached",
        sessionKey: "tg_dm_owner@a",
        sessionPath: activeKey,
      }),
      activeKey,
    );
  });
});
