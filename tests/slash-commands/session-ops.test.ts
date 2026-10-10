// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createSessionOps } from "../../core/slash-commands/session-ops.js";
import { parseSessionHistoryText } from "../../core/message-utils.js";

let tmpDir;
let agentsDir;
let agents;
let engine;

function sessionDirFor(id) {
  return path.join(agentsDir, id, "sessions");
}

function bridgeDirFor(id) {
  return path.join(sessionDirFor(id), "bridge");
}

function readIndex(id) {
  const p = path.join(bridgeDirFor(id), "bridge-sessions.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : {};
}

function writeIndex(id, data) {
  fs.mkdirSync(bridgeDirFor(id), { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDirFor(id), "bridge-sessions.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function writeDesktopSession(id, file = "session-1.jsonl") {
  const sessionDir = sessionDirFor(id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, file);
  const now = "2026-01-01T00:00:00.000Z";
  const rows = [
    { type: "session", version: 3, id: file.replace(/\.jsonl$/, ""), timestamp: now, cwd: tmpDir },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
  ];
  fs.writeFileSync(sessionPath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf-8");
  return sessionPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-ops-"));
  agentsDir = path.join(tmpDir, "agents");
  agents = {
    a1: { id: "a1", sessionDir: sessionDirFor("a1") },
    a2: { id: "a2", sessionDir: sessionDirFor("a2") },
  };
  for (const agent of Object.values(agents)) {
    fs.mkdirSync(path.join(agent.sessionDir, "bridge", "owner"), { recursive: true });
  }

  engine = {
    agentsDir,
    getAgent: vi.fn((id) => agents[id] || null),
    isBridgeSessionStreaming: vi.fn(() => false),
    abortBridgeSession: vi.fn(async () => true),
    isSessionStreaming: vi.fn(() => false),
    abortSession: vi.fn(async () => false),
    closeSession: vi.fn(async () => {}),
    setSessionPinned: vi.fn(async () => null),
    clearSessionTitle: vi.fn(async () => {}),
    emitEvent: vi.fn(),
    rcState: {
      invalidateDesktopSession: vi.fn(() => ({ detachedAttachments: [] })),
    },
    bridgeSessionManager: {
      readIndex: (agent) => readIndex(agent.id),
      writeIndex: (idx, agent) => writeIndex(agent.id, idx),
      injectMessage: vi.fn(() => true),
    },
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionOps bridge kind", () => {
  it("keeps bridge rotate behavior for jsonl-backed sessions", async () => {
    const jsonl = "owner/session-1.jsonl";
    fs.writeFileSync(path.join(bridgeDirFor("a1"), jsonl), "{}\n", "utf-8");
    writeIndex("a1", { "tg_dm_x@a1": { file: jsonl, name: "Alice" } });

    const ops = createSessionOps({ engine });
    const res = await ops.rotate({ kind: "bridge", sessionKey: "tg_dm_x@a1", agentId: "a1" });

    expect(res).toEqual({ status: "rotated" });
    expect(readIndex("a1")["tg_dm_x@a1"]).toMatchObject({ name: "Alice" });
    expect(readIndex("a1")["tg_dm_x@a1"].file).toBeUndefined();
    expect(fs.existsSync(path.join(bridgeDirFor("a1"), jsonl))).toBe(false);
    const listing = fs.readdirSync(path.join(bridgeDirFor("a1"), "owner"));
    expect(listing.some(f => /\.archived-\d+-[a-z0-9]+\.jsonl$/.test(f))).toBe(true);
  });

  it("keeps bridge delete behavior for legacy string index entries", async () => {
    const jsonl = "owner/legacy.jsonl";
    fs.writeFileSync(path.join(bridgeDirFor("a1"), jsonl), "{}\n", "utf-8");
    writeIndex("a1", { "tg_dm_y@a1": jsonl });

    const ops = createSessionOps({ engine });
    const res = await ops.delete({ kind: "bridge", sessionKey: "tg_dm_y@a1", agentId: "a1" });

    expect(res).toEqual({ status: "deleted" });
    expect(readIndex("a1")["tg_dm_y@a1"]).toBeUndefined();
    expect(fs.existsSync(path.join(bridgeDirFor("a1"), jsonl))).toBe(false);
  });

  it("delegates bridge injection to bridgeSessionManager", () => {
    const ops = createSessionOps({ engine });
    const ok = ops.injectAssistantMessage({ kind: "bridge", sessionKey: "k", agentId: "a1" }, "hi");
    expect(ok).toBe(true);
    expect(engine.bridgeSessionManager.injectMessage).toHaveBeenCalledWith("k", "hi", { agentId: "a1" });
  });
});

describe("SessionOps desktop kind", () => {
  it("injects an assistant message into a desktop session file", () => {
    const sessionPath = writeDesktopSession("a1");
    const ops = createSessionOps({ engine });

    const ok = ops.injectAssistantMessage({ kind: "desktop", agentId: "a1", sessionPath }, "desktop reply");

    expect(ok).toBe(true);
    const messages = parseSessionHistoryText(fs.readFileSync(sessionPath, "utf-8"));
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "desktop reply" }],
    });
  });

  it("rotates a desktop session into the agent archived folder and notifies listeners", async () => {
    const sessionPath = writeDesktopSession("a1");
    engine.rcState.invalidateDesktopSession.mockReturnValueOnce({
      detachedAttachments: [{ sessionKey: "tg_dm_x@a1", desktopSessionPath: sessionPath }],
    });
    const ops = createSessionOps({ engine });

    const res = await ops.rotate({ kind: "desktop", agentId: "a1", sessionPath });

    const archivedPath = path.join(sessionDirFor("a1"), "archived", path.basename(sessionPath));
    expect(res).toEqual({ status: "rotated" });
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(engine.closeSession).toHaveBeenCalledWith(sessionPath);
    expect(engine.setSessionPinned).toHaveBeenCalledWith(sessionPath, false);
    expect(engine.rcState.invalidateDesktopSession).toHaveBeenCalledWith(sessionPath);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bridge_rc_detached", sessionKey: "tg_dm_x@a1" }),
      sessionPath,
    );
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessions_changed", sessionPath }),
      sessionPath,
    );
  });

  it("deletes a desktop session and clears title metadata", async () => {
    const sessionPath = writeDesktopSession("a1");
    const ops = createSessionOps({ engine });

    const res = await ops.delete({ kind: "desktop", agentId: "a1", sessionPath });

    expect(res).toEqual({ status: "deleted" });
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(engine.closeSession).toHaveBeenCalledWith(sessionPath);
    expect(engine.setSessionPinned).toHaveBeenCalledWith(sessionPath, false);
    expect(engine.clearSessionTitle).toHaveBeenCalledWith(sessionPath);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessions_changed", sessionPath }),
      sessionPath,
    );
  });

  it("returns not-found when rotating a missing desktop session file", async () => {
    const sessionPath = path.join(sessionDirFor("a1"), "missing.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const ops = createSessionOps({ engine });

    await expect(ops.rotate({ kind: "desktop", agentId: "a1", sessionPath }))
      .resolves.toEqual({ status: "not-found" });
    expect(engine.closeSession).not.toHaveBeenCalled();
  });

  it("rejects archived desktop paths for active-session operations", async () => {
    const activePath = writeDesktopSession("a1");
    const archivedPath = path.join(sessionDirFor("a1"), "archived", path.basename(activePath));
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.renameSync(activePath, archivedPath);
    const ops = createSessionOps({ engine });

    await expect(ops.delete({ kind: "desktop", agentId: "a1", sessionPath: archivedPath }))
      .rejects.toThrow(/must not be archived/);
  });

  it("rejects desktop paths outside the agents directory", async () => {
    const outside = path.join(tmpDir, "outside.jsonl");
    fs.writeFileSync(outside, "{}\n", "utf-8");
    const ops = createSessionOps({ engine });

    await expect(ops.rotate({ kind: "desktop", agentId: "a1", sessionPath: outside }))
      .rejects.toThrow(/active agent session/);
  });

  it("returns false for desktop injection when the file is missing", () => {
    const sessionPath = path.join(sessionDirFor("a1"), "missing.jsonl");
    const ops = createSessionOps({ engine });

    expect(ops.injectAssistantMessage({ kind: "desktop", agentId: "a1", sessionPath }, "lost")).toBe(false);
  });
});
