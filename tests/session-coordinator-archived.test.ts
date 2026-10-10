import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

async function loadCoord(tmpDir) {
  const { SessionCoordinator } = await import("../core/session-coordinator.ts");
  const deps = {
    agentsDir: path.join(tmpDir, "agents"),
    listAgents: () => [
      { id: "a", name: "AgentA" },
      { id: "b", name: "AgentB" },
    ],
    getAgent: (id) => id
      ? { id, agentName: `Agent${id.toUpperCase()}` }
      : { id: "a", agentName: "AgentA" },
    getActiveAgentId: () => "a",
    agentIdFromSessionPath: (p) => {
      const rel = path.relative(path.join(tmpDir, "agents"), p);
      return rel.split(path.sep)[0];
    },
    listDeletedAgents: () => [],
    isAgentDeleted: () => false,
  };
  return new SessionCoordinator(deps);
}

describe("session-coordinator: archived helpers", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "codia-coord-arch-"));
  });

  afterEach(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clearSessionTitle removes entry from session-titles.json", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    await fs.mkdir(sessDir, { recursive: true });
    const sessionPath = path.join(sessDir, "s1.jsonl");
    const titlePath = path.join(sessDir, "session-titles.json");
    await fs.writeFile(
      titlePath,
      JSON.stringify({ [sessionPath]: "My Title", other: "keep" }),
    );

    const coord = await loadCoord(tmpDir);
    await coord.clearSessionTitle(sessionPath);

    const raw = JSON.parse(await fs.readFile(titlePath, "utf-8"));
    expect(raw[sessionPath]).toBeUndefined();
    expect(raw.other).toBe("keep");
  });

  it("clearSessionTitle is a no-op when titles.json missing", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    await fs.mkdir(sessDir, { recursive: true });
    const coord = await loadCoord(tmpDir);
    await expect(
      coord.clearSessionTitle(path.join(sessDir, "s1.jsonl")),
    ).resolves.toBeUndefined();
  });

  it("listArchivedSessions aggregates across agents, sorts by mtime desc", async () => {
    const aArch = path.join(tmpDir, "agents", "a", "sessions", "archived");
    const bArch = path.join(tmpDir, "agents", "b", "sessions", "archived");
    await fs.mkdir(aArch, { recursive: true });
    await fs.mkdir(bArch, { recursive: true });
    const now = Date.now();
    await fs.writeFile(path.join(aArch, "a1.jsonl"), "{}\n");
    await fs.utimes(
      path.join(aArch, "a1.jsonl"),
      (now - 86400000) / 1000,
      (now - 86400000) / 1000,
    );
    await fs.writeFile(path.join(bArch, "b1.jsonl"), "{}\n");
    await fs.utimes(
      path.join(bArch, "b1.jsonl"),
      (now - 3600_000) / 1000,
      (now - 3600_000) / 1000,
    );
    await fs.writeFile(path.join(bArch, "b2.jsonl"), "{}\n");
    await fs.utimes(path.join(bArch, "b2.jsonl"), now / 1000, now / 1000);

    const coord = await loadCoord(tmpDir);
    const list = await coord.listArchivedSessions();

    expect(list.length).toBe(3);
    expect(list.map((s) => path.basename(s.path))).toEqual([
      "b2.jsonl",
      "b1.jsonl",
      "a1.jsonl",
    ]);
    expect(list[0].agentId).toBe("b");
    expect(list[0].agentName).toBe("AgentB");
    expect(typeof list[0].sizeBytes).toBe("number");
    expect(list[0].archivedAt).toBeTruthy();
  });

  it("listArchivedSessions reads title from session-titles.json by active-path key", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    const aArch = path.join(sessDir, "archived");
    await fs.mkdir(aArch, { recursive: true });
    await fs.writeFile(path.join(aArch, "x.jsonl"), "{}\n");
    const activeKey = path.join(sessDir, "x.jsonl");
    await fs.writeFile(
      path.join(sessDir, "session-titles.json"),
      JSON.stringify({ [activeKey]: "Preserved" }),
    );

    const coord = await loadCoord(tmpDir);
    const list = await coord.listArchivedSessions();
    expect(list[0].title).toBe("Preserved");
  });

  it("listSessions includes tombstoned agent sessions as read-only deleted-agent history", async () => {
    const sessDir = path.join(tmpDir, "agents", "deleted", "sessions");
    await fs.mkdir(sessDir, { recursive: true });
    const sessionPath = path.join(sessDir, "d1.jsonl");
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session", version: 3, id: "d1", timestamp: "2026-06-03T01:00:00.000Z", cwd: "/tmp/deleted" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-06-03T01:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "old hello" }], timestamp: 1 } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-06-03T01:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: 2 } }),
      ].join("\n") + "\n",
    );

    const { SessionCoordinator } = await import("../core/session-coordinator.ts");
    const coord = new SessionCoordinator({
      agentsDir: path.join(tmpDir, "agents"),
      listAgents: () => [],
      listDeletedAgents: () => [{ id: "deleted", name: "Deleted Agent", deletedAt: "2026-06-03T01:03:00.000Z" }],
      isAgentDeleted: (id) => id === "deleted",
      getAgent: () => ({ id: "a", agentName: "AgentA" }),
      getActiveAgentId: () => "a",
      agentIdFromSessionPath: (p) => path.relative(path.join(tmpDir, "agents"), p).split(path.sep)[0],
    });

    const list = await coord.listSessions();
    expect(list).toEqual([
      expect.objectContaining({
        path: sessionPath,
        agentId: "deleted",
        agentName: "Deleted Agent",
        agentDeleted: true,
        readOnlyReason: "agent_deleted",
        continuationAvailable: true,
      }),
    ]);
  });

  it("continues a deleted-agent session into the primary agent and keeps it when fresh compaction fails", async () => {
    const agentsDir = path.join(tmpDir, "agents");
    const deletedSessionDir = path.join(agentsDir, "deleted", "sessions");
    const targetSessionDir = path.join(agentsDir, "codia", "sessions");
    const sourcePath = path.join(deletedSessionDir, "old.jsonl");
    const targetPath = path.join(targetSessionDir, "continued.jsonl");
    const normalizedDeletedCwd = path.resolve("/tmp/deleted");
    await fs.mkdir(deletedSessionDir, { recursive: true });
    await fs.mkdir(targetSessionDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      [
        JSON.stringify({ type: "session", version: 3, id: "old", timestamp: "2026-06-03T01:00:00.000Z", cwd: "/tmp/deleted" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-06-03T01:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "old hello" }], timestamp: 1 } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-06-03T01:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "<think>private</think>old reply" }], timestamp: 2 } }),
      ].join("\n") + "\n",
    );

    const appendedMessages = [];
    const manager = {
      appendMessage: vi.fn((message) => appendedMessages.push(message)),
      appendModelChange: vi.fn(),
      getCwd: vi.fn(() => "/tmp/deleted"),
      _rewriteFile: vi.fn(),
    };

    const { SessionCoordinator } = await import("../core/session-coordinator.ts");
    const coord = new SessionCoordinator({
      agentsDir,
      getPrefs: () => ({ getPrimaryAgent: () => "codia" }),
      getActiveAgentId: () => "fallback",
      getAgent: () => ({ id: "fallback", agentName: "Fallback" }),
      getAgentById: (id) => id === "codia"
        ? { id: "codia", agentName: "Codia", agentDir: path.join(agentsDir, "codia"), sessionDir: targetSessionDir }
        : null,
      getHomeCwd: () => "/tmp/codia-home",
      agentIdFromSessionPath: (p) => path.relative(agentsDir, p).split(path.sep)[0],
      isAgentDeleted: (id) => id === "deleted",
      listAgents: () => [],
      listDeletedAgents: () => [{ id: "deleted", name: "Deleted Agent", deletedAt: "2026-06-03T01:03:00.000Z" }],
      emitEvent: vi.fn(),
    });

    coord.createSession = vi.fn(async () => ({
      sessionPath: targetPath,
      agentId: "codia",
      session: {
        model: { provider: "openai", id: "gpt-test" },
        sessionManager: manager,
      },
    } as unknown as Awaited<ReturnType<typeof coord.createSession>>));
    coord.discardSessionRuntime = vi.fn(async () => true);
    coord._freshCompactDeletedAgentContinuation = vi.fn(async () => {
      throw new Error("summary model unavailable");
    });

    const result = await coord.continueDeletedAgentSession(sourcePath);

    expect(coord.createSession).toHaveBeenCalledWith(null, normalizedDeletedCwd, true, null, expect.objectContaining({
      agentId: "codia",
      visibleInSessionList: true,
    }));
    expect(appendedMessages).toEqual([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "old hello" }] }),
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "old reply" }] }),
    ]);
    expect(manager.appendModelChange).toHaveBeenCalledWith("openai", "gpt-test");
    expect(result).toMatchObject({
      sessionPath: targetPath,
      agentId: "codia",
      agentName: "Codia",
      cwd: "/tmp/deleted",
      compacted: false,
      compactionError: "summary model unavailable",
    });
    expect(coord.discardSessionRuntime).not.toHaveBeenCalled();

    const metaPath = path.join(targetSessionDir, "session-meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    expect(meta["continued.jsonl"].continuedFrom).toMatchObject({
      sourceSessionPath: sourcePath,
      sourceAgentId: "deleted",
      sourceAgentDeleted: true,
    });
  });
});
