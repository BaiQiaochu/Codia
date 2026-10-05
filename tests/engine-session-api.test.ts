// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { GsapEngine } from "../core/engine.ts";
import { autoProjectIdForCwd, UNCATEGORIZED_PROJECT_ID } from "../shared/session-projects.ts";

describe("GsapEngine session API", () => {
  it("exposes session model switch state without leaking coordinator internals", () => {
    const engine = Object.create(GsapEngine.prototype);
    engine._sessionCoord = {
      isSessionSwitching: vi.fn(() => true),
    };

    expect(engine.isSessionSwitching("/tmp/session.jsonl")).toBe(true);
    expect(engine._sessionCoord.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
  });

  it("exposes session runtime reload for stale compact retries", async () => {
    const engine = Object.create(GsapEngine.prototype);
    const reloadedSession = { id: "reloaded" };
    engine._sessionCoord = {
      reloadSessionRuntime: vi.fn(async () => reloadedSession),
    };

    await expect(engine.reloadSessionRuntime("/tmp/session.jsonl", {
      refreshCapabilitySnapshots: true,
    })).resolves.toBe(reloadedSession);
    expect(engine._sessionCoord.reloadSessionRuntime).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      { refreshCapabilitySnapshots: true },
    );
  });

  it("deletes a project by moving explicit and cwd-derived sessions to uncategorized", async () => {
    const engine = Object.create(GsapEngine.prototype);
    const cwdProjectId = autoProjectIdForCwd("/tmp/project-gsap");
    engine._sessionProjects = {
      deleteProject: vi.fn(() => ({ folders: [], projects: [] })),
    };
    engine._sessionCoord = {
      listSessions: vi.fn(async () => [
        { path: "/tmp/agents/gsap/sessions/explicit.jsonl", cwd: "/elsewhere", projectId: cwdProjectId },
        { path: "/tmp/agents/gsap/sessions/implicit.jsonl", cwd: "/tmp/project-gsap", projectId: null },
        { path: "/tmp/agents/gsap/sessions/other.jsonl", cwd: "/tmp/other", projectId: null },
      ]),
      writeSessionMeta: vi.fn(async () => undefined),
    };

    const result = await engine.deleteSessionProject(cwdProjectId);

    expect(engine._sessionProjects.deleteProject).toHaveBeenCalledWith(cwdProjectId);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledTimes(2);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/gsap/sessions/explicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/gsap/sessions/implicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(result).toEqual({
      catalog: { folders: [], projects: [] },
      assignment: {
        projectId: UNCATEGORIZED_PROJECT_ID,
        sessionPaths: [
          "/tmp/agents/gsap/sessions/explicit.jsonl",
          "/tmp/agents/gsap/sessions/implicit.jsonl",
        ],
      },
    });
  });

  it("uses the upstream cache-preserving compaction wrapper for desktop compact", async () => {
    const engine = Object.create(GsapEngine.prototype);
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => undefined),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
      },
      getContextUsage: vi
        .fn()
        .mockReturnValueOnce({ tokens: 120_000, contextWindow: 200_000 })
        .mockReturnValueOnce({ tokens: 20_000, contextWindow: 200_000 }),
    };
    engine.getSessionByPath = vi.fn(() => session);
    engine.isSessionStreaming = vi.fn(() => false);
    engine._sessionCoord = {
      refreshSessionCapabilityBaseline: vi.fn(async () => undefined),
    };

    const result = await engine.compactDesktopSession("/tmp/session.jsonl");

    expect(session.extensionRunner.assertActive).toHaveBeenCalledOnce();
    expect(session.extensionRunner.hasHandlers).toHaveBeenCalledWith("session_before_compact");
    expect(session.compact).toHaveBeenCalledWith(undefined);
    expect(engine._sessionCoord.refreshSessionCapabilityBaseline).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(result).toMatchObject({
      tokensBefore: 120_000,
      tokensAfter: 20_000,
      contextWindow: 200_000,
    });
  });

  it("rebuilds ResourceIO when the focused session workspace scope changes", () => {
    const engine = Object.create(GsapEngine.prototype);
    const scopes = {
      "/sessions/a.jsonl": {
        cwd: "/workspace/a",
        workspaceFolders: ["/workspace/a", "/shared/a"],
        authorizedFolders: ["/authorized/a"],
        permissionMode: "operate",
      },
      "/sessions/b.jsonl": {
        cwd: "/workspace/b",
        workspaceFolders: ["/workspace/b"],
        authorizedFolders: ["/authorized/b"],
        permissionMode: "read_only",
      },
    };
    engine.gsapHome = "/gsap-home";
    engine.userDir = "/gsap-home/user";
    engine.agentsDir = "/gsap-home/agents";
    engine._agentMgr = { agent: { dir: "/gsap-home/agents/gsap" } };
    engine._runtimeContext = { studioId: null };
    engine._sessionFiles = null;
    engine._resourceIO = null;
    engine.getResourceService = vi.fn(() => null);
    engine._emitEvent = vi.fn();
    engine._readPreferences = vi.fn(() => ({ sandbox: true }));
    engine._sessionCoord = {
      currentSessionPath: "/sessions/a.jsonl",
      getSessionByPath: vi.fn((sessionPath) => ({
        sessionManager: { getCwd: () => scopes[sessionPath].cwd },
      })),
      getSessionWorkspaceFolders: vi.fn((sessionPath) => scopes[sessionPath].workspaceFolders),
      getSessionAuthorizedFolders: vi.fn((sessionPath) => scopes[sessionPath].authorizedFolders),
      getPermissionMode: vi.fn((sessionPath) => scopes[sessionPath].permissionMode),
    };

    const first = engine.getResourceIO();
    expect(first.providers.local_fs.cwd).toBe("/workspace/a");
    expect(first.providers.local_fs.guard.cwd).toBe("/workspace/a");
    expect(first.providers.local_fs.guard.workspaceFolders).toEqual(["/workspace/a", "/shared/a"]);
    expect(first.providers.local_fs.guard.resolveAuthorizedFolders()).toEqual(["/authorized/a"]);
    expect(first.providers.local_fs.guard.getSandboxEnabled()).toBe(true);

    engine._sessionCoord.currentSessionPath = "/sessions/b.jsonl";
    const second = engine.getResourceIO();

    expect(second).not.toBe(first);
    expect(second.providers.local_fs.cwd).toBe("/workspace/b");
    expect(second.providers.local_fs.guard.workspaceFolders).toEqual(["/workspace/b"]);
    expect(second.providers.local_fs.guard.resolveAuthorizedFolders()).toEqual(["/authorized/b"]);
  });

  it("reloads the desktop runtime and retries when compact sees a stale extension context", async () => {
    const engine = Object.create(GsapEngine.prototype);
    const staleSession = {
      isCompacting: false,
      compact: vi.fn(async () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
      },
      getContextUsage: vi.fn(() => ({ tokens: 90_000, contextWindow: 200_000 })),
    };
    const reloadedSession = {
      isCompacting: false,
      compact: vi.fn(async () => undefined),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
      },
      getContextUsage: vi.fn(() => ({ tokens: 15_000, contextWindow: 200_000 })),
    };
    engine.getSessionByPath = vi.fn(() => staleSession);
    engine.reloadSessionRuntime = vi.fn(async () => reloadedSession);
    engine.isSessionStreaming = vi.fn(() => false);
    engine._sessionCoord = {
      refreshSessionCapabilityBaseline: vi.fn(async () => undefined),
    };

    const result = await engine.compactDesktopSession("/tmp/session.jsonl");

    expect(engine.reloadSessionRuntime).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(reloadedSession.extensionRunner.hasHandlers).toHaveBeenCalledWith("session_before_compact");
    expect(reloadedSession.compact).toHaveBeenCalledWith(undefined);
    expect(result.tokensBefore).toBe(15_000);
    expect(result.tokensAfter).toBe(15_000);
  });

  it("fresh-compacts a loaded desktop session and refreshes the capability snapshot", async () => {
    const engine = Object.create(GsapEngine.prototype);
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => undefined),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
      },
      getContextUsage: vi
        .fn()
        .mockReturnValueOnce({ tokens: 110_000, contextWindow: 200_000 })
        .mockReturnValueOnce({ tokens: 18_000, contextWindow: 200_000 }),
    };
    engine.getSessionByPath = vi.fn(() => session);
    engine.ensureSessionLoaded = vi.fn(async () => session);
    engine.isSessionStreaming = vi.fn(() => false);
    engine._sessionCoord = {
      reloadSessionRuntime: vi.fn(async () => session),
    };

    const result = await engine.freshCompactDesktopSession("/tmp/session.jsonl");

    expect(session.extensionRunner.hasHandlers).toHaveBeenCalledWith("session_before_compact");
    expect(session.compact).toHaveBeenCalledWith(undefined);
    expect(engine._sessionCoord.reloadSessionRuntime).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      { refreshCapabilitySnapshots: true },
    );
    expect(result).toMatchObject({
      tokensBefore: 110_000,
      tokensAfter: 18_000,
      contextWindow: 200_000,
      fresh: true,
      noopReason: null,
    });
  });

  it("reloads the desktop runtime before refreshing snapshots when the compaction hook is missing", async () => {
    const engine = Object.create(GsapEngine.prototype);
    const staleSession = {
      isCompacting: false,
      compact: vi.fn(),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn(() => false),
      },
      getContextUsage: vi.fn(() => ({ tokens: 30_000, contextWindow: 200_000 })),
    };
    const reloadedSession = {
      isCompacting: false,
      compact: vi.fn(async () => {
        throw new Error("Nothing to compact (session too small)");
      }),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
      },
      getContextUsage: vi.fn(() => ({ tokens: 30_000, contextWindow: 200_000 })),
    };
    engine.getSessionByPath = vi.fn(() => staleSession);
    engine.ensureSessionLoaded = vi.fn(async () => staleSession);
    engine.reloadSessionRuntime = vi.fn(async () => reloadedSession);
    engine.isSessionStreaming = vi.fn(() => false);
    engine._sessionCoord = {
      reloadSessionRuntime: vi.fn(async () => reloadedSession),
    };

    const result = await engine.freshCompactDesktopSession("/tmp/session.jsonl");

    expect(staleSession.compact).not.toHaveBeenCalled();
    expect(engine.reloadSessionRuntime).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(reloadedSession.compact).toHaveBeenCalledWith(undefined);
    expect(engine._sessionCoord.reloadSessionRuntime).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      { refreshCapabilitySnapshots: true },
    );
    expect(result).toMatchObject({
      tokensBefore: 30_000,
      tokensAfter: 30_000,
      contextWindow: 200_000,
      fresh: true,
      noopReason: "nothing_to_compact",
    });
  });
});
