import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { replayLatestUserTurnMock, latestTodosMock, latestTodoSnapshotMock } = vi.hoisted(() => ({
  replayLatestUserTurnMock: vi.fn(async () => ({ text: null, toolMedia: [] })),
  latestTodosMock: vi.fn(async () => null),
  latestTodoSnapshotMock: vi.fn(async () => null),
}));

const browserManagerMock = {
  _sessions: new Map(), // sessionPath -> { running, url }
  isRunning(sp) { return this._sessions.get(sp)?.running ?? false; },
  currentUrl(sp) { return this._sessions.get(sp)?.url ?? null; },
  get hasAnyRunning() { for (const s of this._sessions.values()) if (s.running) return true; return false; },
  suspendForSession: vi.fn(async (sp) => {
    const s = browserManagerMock._sessions.get(sp);
    if (s) s.running = false;
  }),
  resumeForSession: vi.fn(async (sp) => {
    browserManagerMock._sessions.set(sp, { running: true, url: "https://after.example.com" });
  }),
  resumeForSessionIfAvailable: vi.fn(async (sp) => {
    await browserManagerMock.resumeForSession(sp);
    return {
      status: "resumed",
      canResume: false,
      reason: "already_running",
      hostConnected: true,
      hasResumeState: true,
      running: browserManagerMock.isRunning(sp),
      url: browserManagerMock.currentUrl(sp),
    };
  }),
  closeBrowserForSession: vi.fn(),
  getBrowserSessions: vi.fn(() => ({})),
};

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => browserManagerMock,
  },
}));

vi.mock("../core/message-utils.js", () => ({
  extractTextContent: vi.fn(() => ({ text: "", images: [], thinking: "", toolUses: [] })),
  loadSessionHistoryMessages: vi.fn(async () => []),
  loadLatestAssistantSummaryFromSessionFile: vi.fn(async () => null),
  isValidSessionPath: vi.fn(() => true),
  isActiveSessionPath: vi.fn(() => true),
}));

vi.mock("../core/session-turn-actions.js", () => ({
  replayLatestUserTurn: replayLatestUserTurnMock,
}));

vi.mock("../lib/tools/todo-compat.js", () => ({
  loadLatestTodosFromSessionFile: latestTodosMock,
  loadLatestTodoSnapshotFromSessionFile: latestTodoSnapshotMock,
}));

describe("sessions route", () => {
  let tmpDir;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-sessions-route-"));
    browserManagerMock._sessions.clear();
    browserManagerMock._sessions.set("/tmp/agents/a/sessions/old.jsonl", { running: true, url: "https://before.example.com" });
    browserManagerMock.suspendForSession.mockClear();
    browserManagerMock.resumeForSession.mockClear();
    browserManagerMock.resumeForSessionIfAvailable.mockClear();
    browserManagerMock.closeBrowserForSession.mockClear();
    replayLatestUserTurnMock.mockClear();
    replayLatestUserTurnMock.mockResolvedValue({ text: null, toolMedia: [] });
    latestTodosMock.mockClear();
    latestTodosMock.mockResolvedValue(null);
    latestTodoSnapshotMock.mockClear();
    latestTodoSnapshotMock.mockResolvedValue(null);
  });

  it("restores browser state for the target session after switch", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      messages: [{ role: "assistant", content: "ok" }],
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "gsap",
      agentName: "G-SAP",
      currentModel: {
        id: "mimo-v2.5",
        provider: "mimo",
        api: "openai-completions",
        audio: true,
        video: true,
        defaultThinkingLevel: "high",
      },
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn((_sp) => ({
        messages: [{ role: "assistant", content: "ok" }],
      })),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/a/sessions/new.jsonl", currentSessionPath: "/tmp/agents/a/sessions/old.jsonl" }),
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    expect(browserManagerMock.suspendForSession).toHaveBeenCalledWith("/tmp/agents/a/sessions/old.jsonl");
    expect(browserManagerMock.resumeForSessionIfAvailable).toHaveBeenCalledWith("/tmp/agents/a/sessions/new.jsonl");
    expect(browserManagerMock.resumeForSession).toHaveBeenCalledWith("/tmp/agents/a/sessions/new.jsonl");
    expect(data.browserRunning).toBe(true); // resumeForSession sets it running
    expect(data.browserUrl).toBe("https://after.example.com"); // per-session URL
    expect(data.currentModelVideo).toBe(true);
    expect(data.currentModelVideoTransport).toBe("openai-video-url");
    expect(data.currentModelVideoTransportSupported).toBe(true);
    expect(data.currentModelAudio).toBe(true);
    expect(data.currentModelAudioTransport).toBe("mimo-input-audio");
    expect(data.currentModelAudioTransportSupported).toBe(true);
    expect(data.currentModelDefaultThinkingLevel).toBe("high");
  });

  it("switches by manifest sessionId before trusting a stale legacy path", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const stalePath = "/tmp/agents/gsap/sessions/stale.jsonl";
    const currentPath = "/tmp/agents/gsap/sessions/current.jsonl";
    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/gsap/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "gsap",
      agentName: "G-SAP",
      currentModel: { id: "gpt-test", provider: "openai" },
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_manifest_current"
        ? { sessionId, currentLocator: { path: currentPath } }
        : null),
      listSessions: vi.fn(async () => [{
        path: stalePath,
        sessionId: "sess_manifest_current",
        title: "Stale projected row",
      }]),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
      agentIdFromSessionPath: vi.fn(() => "gsap"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess_manifest_current", path: stalePath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.switchSession).toHaveBeenCalledWith(currentPath);
    expect(data.path).toBe(currentPath);
    expect(data.sessionId).toBe("sess_manifest_current");
  });

  it("does not fail session switch when browser host is unavailable but the target has cold state", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const targetPath = "/tmp/agents/gsap/sessions/browser-cold.jsonl";
    browserManagerMock.resumeForSessionIfAvailable.mockResolvedValueOnce({
      status: "skipped",
      canResume: false,
      reason: "browser_host_unavailable",
      hostConnected: false,
      hasResumeState: true,
      running: false,
      url: "https://cold.example.com",
    });

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/gsap/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "gsap",
      agentName: "G-SAP",
      currentModel: { id: "gpt-test", provider: "openai" },
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
      agentIdFromSessionPath: vi.fn(() => "gsap"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.switchSession).toHaveBeenCalledWith(targetPath);
    expect(browserManagerMock.resumeForSessionIfAvailable).toHaveBeenCalledWith(targetPath);
    expect(browserManagerMock.resumeForSession).not.toHaveBeenCalledWith(targetPath);
    expect(data.browserResume).toMatchObject({
      status: "skipped",
      reason: "browser_host_unavailable",
      hostConnected: false,
    });
  });

  it("includes pinnedAt in the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const pinnedAt = "2026-04-29T08:00:00.000Z";

    const engine = {
      listSessions: vi.fn(async () => [{
        path: "/tmp/agents/gsap/sessions/a.jsonl",
        title: "Pinned thread",
        firstMessage: "hello",
        modified: new Date("2026-04-29T07:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/work",
        agentId: "gsap",
        agentName: "G-SAP",
        sessionId: "sess_manifest_123",
        revision: "12:3456",
        pinnedAt,
      }]),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].id).toBe("a");
    expect(data[0].sessionId).toBe("sess_manifest_123");
    expect(data[0].revision).toBe("12:3456");
    expect(data[0].pinnedAt).toBe(pinnedAt);
  });

  it("switches by stable sessionId when a pinned history row has a stale path", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const stalePath = "/tmp/agents/gsap/sessions/stale.jsonl";
    const currentPath = "/tmp/agents/gsap/sessions/current.jsonl";
    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/gsap/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "gsap",
      agentName: "G-SAP",
      currentModel: { id: "gpt-test", provider: "openai" },
      listSessions: vi.fn(async () => [{
        path: currentPath,
        sessionId: "sess_manifest_123",
        title: "Pinned migrated thread",
        modified: new Date("2026-04-29T07:00:00.000Z"),
      }]),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
      agentIdFromSessionPath: vi.fn(() => "gsap"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: stalePath,
        sessionId: "sess_manifest_123",
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.switchSession).toHaveBeenCalledWith(currentPath);
    expect(data.path).toBe(currentPath);
    expect(data.sessionId).toBe("sess_manifest_123");
  });

  it("gets and updates session authorized folders", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentDir = path.join(tmpDir, "agents", "gsap");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionDir, "one.jsonl");
    const authorized = path.join(tmpDir, "external-assets");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(authorized, { recursive: true });
    fs.writeFileSync(sessionPath, "");

    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      getSessionFolderScope: vi.fn(() => ({
        sessionPath,
        cwd: path.join(tmpDir, "workspace"),
        workspaceFolders: [],
        authorizedFolders: [],
        sandboxFolders: [path.join(tmpDir, "workspace")],
      })),
      addSessionAuthorizedFolder: vi.fn(async (_sessionPath, folder) => ({
        sessionPath,
        cwd: path.join(tmpDir, "workspace"),
        workspaceFolders: [],
        authorizedFolders: [folder],
        sandboxFolders: [path.join(tmpDir, "workspace"), folder],
      })),
    };

    app.route("/api", createSessionsRoute(engine));

    const getRes = await app.request(`/api/sessions/authorized-folders?path=${encodeURIComponent(sessionPath)}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      ok: true,
      sessionPath,
      authorizedFolders: [],
    });

    const patchRes = await app.request("/api/sessions/authorized-folders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath, action: "add", folder: authorized }),
    });
    const patchData = await patchRes.json();
    expect(patchRes.status).toBe(200);
    expect(engine.addSessionAuthorizedFolder).toHaveBeenCalledWith(sessionPath, path.resolve(authorized));
    expect(patchData.authorizedFolders).toEqual([path.resolve(authorized)]);
  });

  it("searches sessions by title or content without returning full message text", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/a/sessions/search.jsonl";
    const engine = {
      listSessions: vi.fn(async () => [{
        path: sessionPath,
        title: "Media routing notes",
        firstMessage: "first prompt",
        allMessagesText: "Long private body about plugin action scheduling.",
        modified: new Date("2026-05-22T08:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/project",
        agentId: "a",
        agentName: "Agent A",
      }]),
    };

    app.route("/api", createSessionsRoute(engine));

    const titleRes = await app.request("/api/sessions/search?q=media&phase=title");
    const titleData = await titleRes.json();
    expect(titleRes.status).toBe(200);
    expect(titleData.results[0]).toMatchObject({
      path: sessionPath,
      matchKind: "title",
    });
    expect(titleData.results[0]).not.toHaveProperty("allMessagesText");

    const contentRes = await app.request("/api/sessions/search?q=plugin%20action&phase=content");
    const contentData = await contentRes.json();
    expect(contentRes.status).toBe(200);
    expect(contentData.results[0]).toMatchObject({
      path: sessionPath,
      matchKind: "content",
    });
    expect(contentData.results[0].snippet).toContain("plugin action");
  });

  it("includes hasSummary in the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const summaryManager = {
      getSummary: vi.fn(() => ({
        session_id: "a",
        summary: "short summary",
        created_at: "2026-04-29T07:00:00.000Z",
        updated_at: "2026-04-29T08:00:00.000Z",
      })),
    };

    const engine = {
      listSessions: vi.fn(async () => [{
        path: "/tmp/agents/gsap/sessions/a.jsonl",
        title: "Summarized thread",
        firstMessage: "hello",
        modified: new Date("2026-04-29T07:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/work",
        agentId: "gsap",
        agentName: "G-SAP",
      }]),
      getAgent: vi.fn(() => ({ summaryManager })),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].hasSummary).toBe(true);
    expect(summaryManager.getSummary).toHaveBeenCalledWith("a");
  });

  it("returns a session summary for the history context menu", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/with-summary.jsonl";
    const summaryManager = {
      getSummary: vi.fn(() => ({
        session_id: "with-summary",
        summary: "### Important facts\n- User is working on memory.",
        created_at: "2026-04-29T07:00:00.000Z",
        updated_at: "2026-04-29T08:00:00.000Z",
      })),
    };

    const engine = {
      agentsDir: "/tmp/agents",
      agentIdFromSessionPath: vi.fn(() => "gsap"),
      getAgent: vi.fn(() => ({ summaryManager })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/summary?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      hasSummary: true,
      summary: "### Important facts\n- User is working on memory.",
      createdAt: "2026-04-29T07:00:00.000Z",
      updatedAt: "2026-04-29T08:00:00.000Z",
    });
    expect(engine.agentIdFromSessionPath).toHaveBeenCalledWith(sessionPath);
    expect(summaryManager.getSummary).toHaveBeenCalledWith("with-summary");
  });

  it("returns an empty summary state when the session has no summary", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const engine = {
      agentsDir: "/tmp/agents",
      agentIdFromSessionPath: vi.fn(() => "gsap"),
      getAgent: vi.fn(() => ({ summaryManager: { getSummary: vi.fn(() => null) } })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/summary?path=%2Ftmp%2Fagents%2Fhana%2Fsessions%2Fempty.jsonl");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      hasSummary: false,
      summary: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("loads messages through a stable sessionId", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/a.jsonl";

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([]);

    const engine = {
      agentsDir: "/tmp/agents",
      listSessions: vi.fn(async () => [{ path: sessionPath, title: "Thread A" }]),
      deferredResults: null,
      agentIdFromSessionPath: vi.fn(() => "gsap"),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages?sessionId=a");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(msgUtils.loadSessionHistoryMessages).toHaveBeenCalledWith(engine, sessionPath);
    expect(data).toMatchObject({ messages: [], blocks: [], hasMore: false });
  });

  it("returns the session file revision when loading messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionDir = path.join(agentsDir, "gsap", "sessions");
    const sessionPath = path.join(sessionDir, "revision.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, "{\"type\":\"session\",\"id\":\"revision\"}\n", "utf-8");
    const stat = fs.statSync(sessionPath);

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([]);

    const engine = {
      agentsDir,
      currentSessionPath: sessionPath,
      deferredResults: null,
      agentIdFromSessionPath: vi.fn(() => "gsap"),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.revision).toBe(`${stat.size}:${stat.mtimeMs}`);
  });

  it("loads messages through the current manifest locator when a sessionId has moved", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const stalePath = "/tmp/agents/gsap/sessions/stale.jsonl";
    const currentPath = "/tmp/agents/gsap/sessions/current.jsonl";

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([]);

    const engine = {
      agentsDir: "/tmp/agents",
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_moved"
        ? { sessionId, currentLocator: { path: currentPath } }
        : null),
      listSessions: vi.fn(async () => [{ path: stalePath, sessionId: "sess_moved", title: "Moved" }]),
      deferredResults: null,
      agentIdFromSessionPath: vi.fn(() => "gsap"),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages?sessionId=sess_moved");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(msgUtils.loadSessionHistoryMessages).toHaveBeenLastCalledWith(engine, currentPath);
    expect(data).toMatchObject({ messages: [], blocks: [], hasMore: false });
  });

  it("includes serialized session registry files when loading messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/main.jsonl";

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      runtimeContext: { studioId: "studio_route" },
      deferredResults: null,
      listSessionFiles: vi.fn((sp) => {
        expect(sp).toBe(sessionPath);
        return [{
          id: "sf_write",
          sessionPath,
          filePath: "/workspace/draft.md",
          label: "draft.md",
          ext: "md",
          mime: "text/markdown",
          kind: "markdown",
          origin: "agent_write",
          operations: ["created", "modified"],
          createdAt: 1234,
          status: "available",
        }];
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.sessionFiles).toEqual([expect.objectContaining({
      fileId: "sf_write",
      filePath: "/workspace/draft.md",
      origin: "agent_write",
      operations: ["created", "modified"],
      createdAt: 1234,
      resource: expect.objectContaining({
        resourceId: "res_sf_write",
        name: "studios/studio_route/resources/res_sf_write",
        studioId: "studio_route",
        fileId: "sf_write",
      }),
    })]);
  });

  it("hydrates every legacy file block without fileId from the session file sidecar by path", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/legacy.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "legacy file", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "legacy file" },
      {
        role: "toolResult",
        toolName: "stage_files",
        details: {
          files: [
            { filePath: "/cache/legacy.png", label: "legacy.png", ext: "png" },
            { filePath: "/cache/second.png", label: "second.png", ext: "png" },
          ],
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      listSessionFiles: vi.fn(() => []),
      getSessionFile: vi.fn(),
      getSessionFileByPath: vi.fn((filePath, options) => {
        expect(options).toEqual({ sessionPath });
        if (filePath === "/cache/legacy.png") {
          return {
            id: "sf_legacy",
            filePath,
            label: "legacy.png",
            ext: "png",
            mime: "image/png",
            kind: "image",
            storageKind: "managed_cache",
            status: "expired",
            missingAt: 4321,
          };
        }
        if (filePath === "/cache/second.png") {
          return {
            id: "sf_second",
            filePath,
            label: "second.png",
            ext: "png",
            mime: "image/png",
            kind: "image",
            storageKind: "managed_cache",
            status: "available",
            missingAt: null,
          };
        }
        return null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "file",
      fileId: "sf_legacy",
      filePath: "/cache/legacy.png",
      status: "expired",
      missingAt: 4321,
    });
    expect(data.blocks[1]).toMatchObject({
      type: "file",
      fileId: "sf_second",
      filePath: "/cache/second.png",
      status: "available",
    });
  });

  it("hydrates completed UI-only image generation results when loading messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/image.jsonl";

    vi.mocked(msgUtils.extractTextContent).mockImplementation((content) => ({
      text: typeof content === "string" ? content : "",
      images: [],
      thinking: "",
      toolUses: [],
    }));
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "Submitted image generation." },
      {
        role: "toolResult",
        toolName: "image-gen_generate-image",
        details: {
          mediaGeneration: {
            kind: "image",
            prompt: "portrait",
            tasks: [{ taskId: "img-task-1" }],
          },
        },
      },
      {
        role: "custom",
        customType: "gsap-deferred-result",
        taskId: "img-task-1",
        status: "success",
        type: "image-generation",
        result: {
          sessionFiles: [{
            id: "sf-generated",
            filePath: "E:/generated/portrait.png",
            label: "portrait.png",
            ext: "png",
            mime: "image/png",
            kind: "image",
          }],
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      listSessionFiles: vi.fn(() => []),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toEqual([
      expect.objectContaining({
        type: "interlude",
        taskId: "img-task-1",
        status: "success",
        variant: "deferred_result",
      }),
      expect.objectContaining({
        type: "file",
        fileId: "sf-generated",
        filePath: "E:/generated/portrait.png",
        replacesTaskId: "img-task-1",
      }),
    ]);
  });

  it("exports session history as ordinary JSON through a stable sessionId", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/a.jsonl";
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce(messages);

    const engine = {
      agentsDir: "/tmp/agents",
      listSessions: vi.fn(async () => [{ path: sessionPath, title: "Thread A" }]),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/export.json?sessionId=a&download=1");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="a.json"');
    expect(msgUtils.loadSessionHistoryMessages).toHaveBeenCalledWith(engine, sessionPath);
    expect(data).toMatchObject({
      id: "a",
      path: sessionPath,
      format: "json",
      messages,
    });
    expect(typeof data.exportedAt).toBe("string");
  });

  it("routes latest user message replay through the session turn action", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "a.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");

    const engine = {
      agentsDir,
      isSessionStreaming: vi.fn(() => false),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/latest-user-message/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: sessionPath,
        sourceEntryId: "entry-u1",
        clientMessageId: "client-u1",
        text: "edited text",
        displayMessage: { text: "edited text" },
        uiContext: { currentTab: "chat" },
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, text: null, toolMedia: [] });
    expect(replayLatestUserTurnMock).toHaveBeenCalledWith(engine, {
      sessionPath,
      sourceEntryId: "entry-u1",
      clientMessageId: "client-u1",
      replacementText: "edited text",
      displayMessage: { text: "edited text" },
      uiContext: { currentTab: "chat" },
    });
  });

  it("marks current todos complete through a debranded custom session state", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "todo.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    const appendCustomMessageEntry = vi.fn();
    latestTodoSnapshotMock.mockResolvedValueOnce({
      removed: false,
      todos: [{ content: "Fix bug", activeForm: "Fixing bug", status: "in_progress" }],
    });

    const engine = {
      agentsDir,
      isSessionStreaming: vi.fn(() => false),
      getSessionByPath: vi.fn(() => ({ sessionManager: { appendCustomMessageEntry } })),
      emitEvent: vi.fn(),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/todos/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, todos: [] });
    expect(appendCustomMessageEntry).toHaveBeenCalledWith(
      "gsap.todo_state",
      expect.stringContaining("[G-SAP Todo]"),
      false,
      expect.objectContaining({
        action: "complete_all",
        source: "user",
        removed: true,
        todos: [expect.objectContaining({ content: "Fix bug", status: "completed" })],
      }),
    );
    expect(engine.emitEvent).toHaveBeenCalledWith({ type: "todo_update", todos: [] }, sessionPath);
  });

  it("broadcasts session_created through the hub when a new session is created", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "new.jsonl");
    const engine = {
      agentsDir,
      cwd: "/workspace",
      config: { cwd_history: [] },
      currentAgentId: "gsap",
      agentName: "G-SAP",
      planMode: false,
      permissionMode: "ask",
      memoryModelUnavailableReason: null,
      createSession: vi.fn(async () => ({ sessionPath, agentId: "gsap" })),
      persistSessionMeta: vi.fn(),
      updateConfig: vi.fn(async () => {}),
      getSessionWorkspaceFolders: vi.fn(() => ["/workspace"]),
      getSessionPermissionMode: vi.fn(() => "ask"),
      getSessionThinkingLevel: vi.fn(() => "auto"),
      getThinkingLevel: vi.fn(() => "auto"),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
    };
    const hub = { eventBus: { emit: vi.fn() } };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.createSession).toHaveBeenCalledWith(
      null,
      "/workspace",
      true,
      undefined,
      expect.objectContaining({
        workspaceFolders: [],
        visibleInSessionList: false,
      }),
    );
    expect(data.path).toBe(sessionPath);
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      {
        type: "session_created",
        session: expect.objectContaining({
          path: sessionPath,
          agentName: "G-SAP",
          cwd: "/workspace",
        }),
      },
      sessionPath,
    );
  });

  it("creates detached sessions for quick chat without moving the focused desktop session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "quick.jsonl");
    const engine = {
      agentsDir,
      cwd: "/workspace",
      currentSessionPath: path.join(agentsDir, "gsap", "sessions", "focused.jsonl"),
      currentAgentId: "gsap",
      agentName: "G-SAP",
      permissionMode: "ask",
      memoryModelUnavailableReason: null,
      createDetachedSession: vi.fn(async () => ({ sessionPath, agentId: "gsap" })),
      persistSessionMeta: vi.fn(),
      getSessionWorkspaceFolders: vi.fn(() => ["/workspace"]),
      getSessionAuthorizedFolders: vi.fn(() => ["/workspace"]),
      getSessionPermissionMode: vi.fn(() => "read_only"),
      getSessionThinkingLevel: vi.fn(() => "medium"),
      getThinkingLevel: vi.fn(() => "auto"),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
    };
    const hub = { eventBus: { emit: vi.fn() } };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/new-detached", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/workspace",
        agentId: "gsap",
        permissionMode: "read_only",
        thinkingLevel: "medium",
        workspaceFolders: ["/workspace"],
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.createDetachedSession).toHaveBeenCalledWith({
      cwd: "/workspace",
      memoryEnabled: true,
      agentId: "gsap",
      workspaceFolders: ["/workspace"],
      visibleInSessionList: true,
      permissionMode: "read_only",
      thinkingLevel: "medium",
    });
    expect(data).toEqual(expect.objectContaining({
      ok: true,
      path: sessionPath,
      currentSessionPath: engine.currentSessionPath,
      permissionMode: "read_only",
      accessMode: "read_only",
      planMode: true,
      agentName: "G-SAP",
    }));
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      {
        type: "session_created",
        session: expect.objectContaining({ path: sessionPath }),
      },
      sessionPath,
    );
  });

  it("creates a primary-agent continuation from a deleted-agent session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const oldPath = path.join(agentsDir, "deleted", "sessions", "old.jsonl");
    const newPath = path.join(agentsDir, "gsap", "sessions", "continued.jsonl");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(
      oldPath,
      JSON.stringify({ type: "session", version: 3, id: "old", timestamp: "2026-06-03T01:00:00.000Z", cwd: "/workspace" }) + "\n",
      "utf-8",
    );

    const engine = {
      agentsDir,
      cwd: "/workspace",
      permissionMode: "ask",
      accessMode: "operate",
      planMode: false,
      memoryModelUnavailableReason: null,
      continueDeletedAgentSession: vi.fn(async () => ({
        sessionPath: newPath,
        agentId: "gsap",
        agentName: "G-SAP",
        cwd: "/workspace",
        workspaceFolders: ["/workspace"],
        authorizedFolders: ["/workspace"],
        compacted: false,
        compactionError: "summary model unavailable",
      })),
      getSessionWorkspaceFolders: vi.fn(() => ["/workspace"]),
      getSessionAuthorizedFolders: vi.fn(() => ["/workspace"]),
      getSessionThinkingLevel: vi.fn(() => "auto"),
      getThinkingLevel: vi.fn(() => "auto"),
      getAgent: vi.fn(() => ({ agentName: "G-SAP" })),
    };
    const hub = { eventBus: { emit: vi.fn() } };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/continue-deleted-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oldPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.continueDeletedAgentSession).toHaveBeenCalledWith(oldPath);
    expect(data).toMatchObject({
      ok: true,
      path: newPath,
      agentId: "gsap",
      agentName: "G-SAP",
      compacted: false,
      compactionError: "summary model unavailable",
    });
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      {
        type: "session_created",
        session: expect.objectContaining({
          path: newPath,
          agentName: "G-SAP",
        }),
      },
      newPath,
    );
  });

  it("pins and unpins sessions through an explicit route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const pinnedAt = "2026-04-29T08:00:00.000Z";

    const engine = {
      agentsDir: "/tmp/agents",
      setSessionPinned: vi.fn(async (_sessionPath, pinned) => (pinned ? pinnedAt : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const pinRes = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/gsap/sessions/a.jsonl", pinned: true }),
    });
    const pinData = await pinRes.json();

    expect(pinRes.status).toBe(200);
    expect(engine.setSessionPinned).toHaveBeenCalledWith("/tmp/agents/gsap/sessions/a.jsonl", true);
    expect(pinData).toEqual({ ok: true, pinnedAt });

    const unpinRes = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/gsap/sessions/a.jsonl", pinned: false }),
    });
    const unpinData = await unpinRes.json();

    expect(unpinRes.status).toBe(200);
    expect(engine.setSessionPinned).toHaveBeenLastCalledWith("/tmp/agents/gsap/sessions/a.jsonl", false);
    expect(unpinData).toEqual({ ok: true, pinnedAt: null });
  });

  it("clears pinned state before archiving a session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "a.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");

    const engine = {
      agentsDir,
      closeSession: vi.fn(async () => {}),
      setSessionPinned: vi.fn(async () => null),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(engine.setSessionPinned).toHaveBeenCalledWith(sessionPath, false);
    expect(fs.existsSync(path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath)))).toBe(true);
  });

  it("cleans up background lifecycle state when archiving a session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "a.jsonl");
    const destPath = path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath));
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");

    const engine = {
      agentsDir,
      closeSession: vi.fn(async () => {}),
      abortSessionByPath: vi.fn(async () => {}),
      setSessionPinned: vi.fn(async () => null),
      taskRegistry: { abortByParentSession: vi.fn() },
      subagentRuns: { abortByParentSession: vi.fn() },
      activityHub: { clearBySession: vi.fn() },
      deferredResults: { suppressBySession: vi.fn() },
      confirmStore: { abortBySession: vi.fn() },
      terminalSessions: { closeForSession: vi.fn() },
      rcState: {
        invalidateDesktopSession: vi.fn(() => ({ detachedAttachments: [] })),
      },
      emitEvent: vi.fn(),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });

    expect(res.status).toBe(200);
    for (const key of [sessionPath, destPath]) {
      expect(engine.taskRegistry.abortByParentSession).toHaveBeenCalledWith(key, "parent session archived");
      expect(engine.subagentRuns.abortByParentSession).toHaveBeenCalledWith(key, "parent session archived");
      expect(engine.activityHub.clearBySession).toHaveBeenCalledWith(key);
      expect(engine.deferredResults.suppressBySession).toHaveBeenCalledWith(key, "parent session archived");
      expect(engine.confirmStore.abortBySession).toHaveBeenCalledWith(key);
      expect(engine.abortSessionByPath).toHaveBeenCalledWith(key);
      expect(engine.terminalSessions.closeForSession).toHaveBeenCalledWith(key);
      expect(browserManagerMock.closeBrowserForSession).toHaveBeenCalledWith(key);
    }
    expect(engine.rcState.invalidateDesktopSession).toHaveBeenCalledWith(sessionPath);
  });

  it("permanently deletes an active session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "gsap", "sessions", "delete-me.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");

    const engine = {
      agentsDir,
      closeSession: vi.fn(async () => {}),
      setSessionPinned: vi.fn(async () => null),
      clearSessionTitle: vi.fn(async () => {}),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(engine.closeSession).toHaveBeenCalledWith(sessionPath);
    expect(engine.setSessionPinned).toHaveBeenCalledWith(sessionPath, false);
    expect(engine.clearSessionTitle).toHaveBeenCalledWith(sessionPath);
    expect(browserManagerMock.closeBrowserForSession).toHaveBeenCalledWith(sessionPath);
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it("deletes by manifest sessionId before trusting a stale projected path", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const stalePath = path.join(agentsDir, "gsap", "sessions", "stale.jsonl");
    const currentPath = path.join(agentsDir, "gsap", "sessions", "current.jsonl");
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(currentPath, "{}\n", "utf-8");

    const engine = {
      agentsDir,
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_current"
        ? { sessionId, currentLocator: { path: currentPath } }
        : null),
      closeSession: vi.fn(async () => {}),
      setSessionPinned: vi.fn(async () => null),
      clearSessionTitle: vi.fn(async () => {}),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: stalePath, sessionId: "sess_current" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(engine.closeSession).toHaveBeenCalledWith(currentPath);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it("infers subagent agent identity from child sessionPath when history details are missing", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "gsap" ? { agentName: "G-SAP" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "gsap",
      agentName: "G-SAP",
      streamKey: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
    });
  });

  it("prefers explicit executor metadata over owner-path inference", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "delegate to butter",
          requestedAgentId: "butter",
          requestedAgentNameSnapshot: "butter",
          executorAgentId: "butter",
          executorAgentNameSnapshot: "butter",
          sessionPath: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => {
        if (id === "gsap") return { agentName: "G-SAP" };
        if (id === "butter") return { agentName: "butter" };
        return null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "butter",
      agentName: "butter",
      requestedAgentId: "butter",
      requestedAgentName: "butter",
      streamKey: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
    });
  });

  it("uses child-session executor snapshot when live agent has been deleted", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    const agentsDir = path.join(tmpDir, "agents");
    const childSessionPath = path.join(agentsDir, "gsap", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");
    fs.writeFileSync(
      path.join(path.dirname(childSessionPath), "session-meta.json"),
      JSON.stringify({
        "child.jsonl": {
          executorAgentId: "deleted-butter",
          executorAgentNameSnapshot: "butter",
          executorMetaVersion: 1,
        },
      }, null, 2),
      "utf-8",
    );

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "legacy delegated task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir,
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative(agentsDir, sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "gsap" ? { agentName: "G-SAP" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "deleted-butter",
      agentName: "butter",
      streamKey: childSessionPath,
    });
  });

  it("hydrates running subagent block from durable run store when deferred delivery state is gone", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile).mockResolvedValueOnce("child finished from durable run");
    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: null,
          streamStatus: "running",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: { query: vi.fn(() => null) },
      subagentRuns: {
        query: vi.fn(() => ({
          taskId: "subagent-1",
          parentSessionPath: "/tmp/agents/gsap/sessions/parent.jsonl",
          childSessionPath: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
          status: "resolved",
          summary: "durable result",
          requestedAgentId: "gsap",
          requestedAgentNameSnapshot: "G-SAP",
          executorAgentId: "gsap",
          executorAgentNameSnapshot: "G-SAP",
          executorMetaVersion: 1,
        })),
      },
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "gsap" ? { agentName: "G-SAP" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.subagentRuns.query).toHaveBeenCalledWith("subagent-1");
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).toHaveBeenCalledWith("/tmp/agents/gsap/subagent-sessions/child.jsonl");
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamKey: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
      streamStatus: "done",
      summary: "child finished from durable run",
      agentId: "gsap",
      agentName: "G-SAP",
    });
  });

  it("marks old unmapped running subagent block failed", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile).mockClear();
    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-legacy",
          task: "legacy child session without persisted mapping",
          sessionPath: null,
          streamStatus: "running",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: { query: vi.fn(() => null) },
      subagentRuns: { query: vi.fn(() => null) },
      agentIdFromSessionPath: vi.fn(() => null),
      getAgent: vi.fn(() => null),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamStatus: "failed",
    });
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).not.toHaveBeenCalled();
  });

  it("marks stale durable pending subagent run failed when deferred runtime task is gone", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile).mockClear();
    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-pending-stale",
          task: "legacy child session still marked running",
          sessionPath: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
          streamStatus: "running",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: { query: vi.fn(() => null) },
      subagentRuns: {
        query: vi.fn(() => ({
          taskId: "subagent-pending-stale",
          parentSessionPath: "/tmp/agents/gsap/sessions/parent.jsonl",
          childSessionPath: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
          status: "pending",
          summary: "legacy pending",
        })),
      },
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "gsap" ? { agentName: "G-SAP" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamKey: "/tmp/agents/gsap/subagent-sessions/child.jsonl",
      streamStatus: "failed",
    });
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).not.toHaveBeenCalled();
  });

  it("routes fresh compact through the desktop fresh compact entrypoint", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/fresh.jsonl";
    const engine = {
      agentsDir: "/tmp/agents",
      freshCompactDesktopSession: vi.fn(async () => ({
        tokensBefore: 100_000,
        tokensAfter: 12_000,
        contextWindow: 200_000,
        fresh: true,
        noopReason: null,
      })),
      compactDesktopSession: vi.fn(async () => {
        throw new Error("ordinary compact must not handle fresh compact");
      }),
      getSessionCapabilityDriftNotice: vi.fn(() => null),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/fresh-compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.freshCompactDesktopSession).toHaveBeenCalledWith(sessionPath);
    expect(engine.compactDesktopSession).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      ok: true,
      tokensBefore: 100_000,
      tokensAfter: 12_000,
      fresh: true,
      capabilityDrift: null,
    });
  });

  it("returns conflict for transient busy fresh compact attempts", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();
    const sessionPath = "/tmp/agents/gsap/sessions/busy.jsonl";
    const engine = {
      agentsDir: "/tmp/agents",
      freshCompactDesktopSession: vi.fn(async () => {
        throw new Error("freshCompactDesktopSession: session is streaming, try again after the reply completes");
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/fresh-compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/session is streaming/);
  });
});
