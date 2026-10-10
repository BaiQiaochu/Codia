import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { SubagentRunStore } from "../lib/subagent-run-store.js";

describe("SubagentRunStore", () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-subagent-runs-"));
    storePath = path.join(tempDir, "subagent-runs.json");
  });

  it("persists taskId to child session mapping independently of deferred delivery state", () => {
    const store = new SubagentRunStore(storePath);

    store.register("subagent-1", {
      parentSessionPath: "/agents/codia/sessions/parent.jsonl",
      threadId: "thread-1",
      threadKind: "direct",
      summary: "check project",
      requestedAgentId: "codia",
      requestedAgentNameSnapshot: "Codia",
    });
    store.attachSession("subagent-1", "/agents/codia/subagent-sessions/child.jsonl", {
      executorAgentId: "codia",
      executorAgentNameSnapshot: "Codia",
      executorMetaVersion: 1,
    });
    store.resolve("subagent-1", "finished summary");

    const restored = new SubagentRunStore(storePath);
    expect(restored.query("subagent-1")).toMatchObject({
      taskId: "subagent-1",
      parentSessionPath: "/agents/codia/sessions/parent.jsonl",
      childSessionPath: "/agents/codia/subagent-sessions/child.jsonl",
      threadId: "thread-1",
      threadKind: "direct",
      status: "resolved",
      summary: "finished summary",
      requestedAgentId: "codia",
      executorAgentId: "codia",
      executorAgentNameSnapshot: "Codia",
    });
  });

  it("aborts pending runs for an archived parent session", () => {
    const store = new SubagentRunStore(storePath);
    store.register("subagent-1", {
      parentSessionPath: "/agents/codia/sessions/a.jsonl",
      requestedAgentId: "codia",
    });
    store.register("subagent-2", {
      parentSessionPath: "/agents/codia/sessions/b.jsonl",
      requestedAgentId: "codia",
    });
    store.resolve("subagent-2", "done");

    const result = store.abortByParentSession(
      "/agents/codia/sessions/a.jsonl",
      "parent session archived",
    );

    expect(result).toMatchObject({ matched: 1, aborted: 1, skippedFinal: 0 });
    expect(store.query("subagent-1")).toMatchObject({
      status: "aborted",
      reason: "parent session archived",
      summary: "parent session archived",
    });
    expect(store.query("subagent-2")).toMatchObject({ status: "resolved" });
  });

  it("aborts pending runs by stable parent session id after the parent path moves", () => {
    const originalPath = "/agents/codia/sessions/original.jsonl";
    const movedPath = "/agents/codia/sessions/archive/renamed.jsonl";
    const sessionId = "sess_subagent_runs";
    const store = new SubagentRunStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });

    store.register("subagent-1", {
      parentSessionPath: originalPath,
      requestedAgentId: "codia",
    });
    store.register("subagent-2", {
      parentSessionPath: "/agents/codia/sessions/other.jsonl",
      requestedAgentId: "codia",
    });

    const result = store.abortByParentSession(movedPath, "parent session archived");

    expect(result).toMatchObject({ matched: 1, aborted: 1, skippedFinal: 0 });
    expect(store.query("subagent-1")).toMatchObject({
      parentSessionId: sessionId,
      parentSessionPath: originalPath,
      status: "aborted",
    });
    expect(store.query("subagent-2")).toMatchObject({ status: "pending" });
  });
});
