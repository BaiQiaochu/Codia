// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSubagentCloseTool,
  createSubagentReplyTool,
  createSubagentTool,
} from "../lib/tools/subagent-tool.js";
import { SubagentThreadStore } from "../lib/subagent-thread-store.js";

// ---- helpers ----------------------------------------------------------------

/** Mock Pi SDK ctx with sessionManager */
const mockCtx = (sp = "/test/session.jsonl") => ({
  sessionManager: { getSessionFile: () => sp },
});

/**
 * Build a mock executeIsolated that:
 *  - calls opts.onSessionReady(sessionPath) synchronously if provided
 *  - resolves with the given result
 */
function makeExecuteIsolated(
  result = { replyText: "done", error: null, sessionPath: "/test/child.jsonl" },
) {
  return vi.fn().mockImplementation((_prompt, opts) => {
    if (typeof opts?.onSessionReady === "function") {
      opts.onSessionReady("/test/child.jsonl");
    }
    return Promise.resolve(result);
  });
}

function makeDeps(overrides = {}) {
  const threadStore = {
    beginRun: vi.fn(),
    attachSession: vi.fn(),
    finishRun: vi.fn(),
    runSerialized: vi.fn((_threadId, taskFn) => taskFn()),
    isBusy: vi.fn(() => false),
    get: vi.fn(() => null),
    closeDirectThread: vi.fn(),
  };
  return {
    executeIsolated: makeExecuteIsolated(),
    resolveUtilityModel: () => "utility-model",
    getDeferredStore: () => ({
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    }),
    getSessionPath: () => "/test/session.jsonl",
    listAgents: vi.fn(() => [
      { id: "codia", name: "Codia", model: "claude-3-5-sonnet", summary: "主 agent" },
      { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
    ]),
    currentAgentId: "codia",
    agentDir: "/test/agents/codia",
    emitEvent: vi.fn(),
    persistSubagentSessionMeta: vi.fn(async () => {}),
    getSubagentThreadStore: () => threadStore,
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe("subagent-tool (executeIsolated 原子模式)", () => {
  let mockStore;
  let deps;

  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
    deps = makeDeps({ getDeferredStore: () => mockStore });
  });

  // 1. fire-and-forget: returns immediately with taskId / streamStatus / sessionPath
  it("dispatches task and returns immediately with running status", async () => {
    const tool = createSubagentTool(deps);
    const task = "任务：查一下项目状态\n\n请阅读当前仓库的未提交改动，并总结风险。";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    // t() returns the key path when locale is not loaded in tests
    expect(result.content[0].text).toMatch(/task-id|subagentDispatched/);
    expect(result.details).toBeDefined();
    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(result.details.streamStatus).toBe("running");
    expect(result.details.sessionPath).toBeNull();
    expect(result.details.task).toBe(task);
    expect(result.details.taskTitle).toBe("任务：查一下项目状态");
    expect(result.details.agentId).toBe("codia");
    expect(result.details.agentName).toBe("Codia");
    expect(result.details.requestedAgentId).toBe("codia");
    expect(result.details.requestedAgentNameSnapshot).toBe("Codia");
    expect(result.details.executorAgentId).toBe("codia");
    expect(result.details.executorAgentNameSnapshot).toBe("Codia");
    expect(result.details.executorMetaVersion).toBe(1);

    // store.defer is called before returning
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent", summary: "任务：查一下项目状态" }),
    );
  });

  it("self-dispatch emits actual agent identity with session-ready patch", async () => {
    const emitEvent = vi.fn();
    const persistSubagentSessionMeta = vi.fn(async () => {});
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
      persistSubagentSessionMeta,
    }));

    const result = await tool.execute("call_1", { task: "当前 agent 自己执行" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({
            streamKey: "/test/child.jsonl",
            agentId: "codia",
            agentName: "Codia",
            requestedAgentId: "codia",
            requestedAgentNameSnapshot: "Codia",
            executorAgentId: "codia",
            executorAgentNameSnapshot: "Codia",
          }),
        }),
        "/test/session.jsonl",
      );
    });

    await vi.waitFor(() => {
      expect(persistSubagentSessionMeta).toHaveBeenCalledWith(
        "/test/child.jsonl",
        expect.objectContaining({
          executorAgentId: "codia",
          executorAgentNameSnapshot: "Codia",
          executorMetaVersion: 1,
        }),
      );
    });
  });

  it("persists lifecycle updates to subagent run store when available", async () => {
    const runStore = {
      register: vi.fn(),
      attachSession: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
    };
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      getSubagentRunStore: () => runStore,
    }));

    const result = await tool.execute("call_1", { task: "durable subagent" }, null, null, mockCtx());
    const { taskId } = result.details;

    expect(runStore.register).toHaveBeenCalledWith(taskId, expect.objectContaining({
      parentSessionPath: "/test/session.jsonl",
      summary: "durable subagent",
      requestedAgentId: "codia",
      executorAgentId: "codia",
    }));
    await vi.waitFor(() => {
      expect(runStore.attachSession).toHaveBeenCalledWith(taskId, "/test/child.jsonl", expect.objectContaining({
        executorAgentId: "codia",
        executorAgentNameSnapshot: "Codia",
        executorMetaVersion: 1,
      }));
      expect(runStore.resolve).toHaveBeenCalledWith(taskId, "done");
    });
    expect(runStore.fail).not.toHaveBeenCalled();
    expect(runStore.abort).not.toHaveBeenCalled();
  });

  it("uses the original first line as taskTitle and dispatches task unchanged", async () => {
    const executeIsolated = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
    }));

    const task = "你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：\n\n1. 作息\n2. 运动";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    expect(result.details.taskTitle).toBe("你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：");
    expect(executeIsolated).toHaveBeenCalledWith(
      task,
      expect.any(Object),
    );
  });

  // 2. deferred store resolves on success
  it("resolves deferred store on success", async () => {
    const tool = createSubagentTool(deps);
    await tool.execute("call_1", { task: "成功的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  // 3. deferred store fails when executeIsolated returns an error
  it("fails deferred store when result.error is set", async () => {
    const failingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "boom", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: failingExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "会失败的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "boom",
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("does not silently fallback to current agent when delegated execution fails", async () => {
    const executeIsolated = vi.fn().mockRejectedValue(new Error("delegated boom"));
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
      emitEvent,
      listAgents: vi.fn(() => [
        { id: "codia", name: "Codia" },
        { id: "butter", name: "butter" },
      ]),
    }));

    const result = await tool.execute("call_1", { task: "委派任务", agent: "butter" }, null, null, mockCtx());

    expect(result.details.requestedAgentId).toBe("butter");
    expect(result.details.executorAgentId).toBe("butter");
    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "delegated boom",
      );
    });
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(executeIsolated).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "butter" }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "block_update",
        patch: expect.objectContaining({ streamStatus: "failed", summary: "delegated boom" }),
      }),
      "/test/session.jsonl",
    );
  });

  // 4. emits block_update with streamStatus: done on success
  it("emits block_update with streamStatus done on success", async () => {
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "完成的任务" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "done" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  // 5. emits block_update with streamStatus: failed on failure
  it("emits block_update with streamStatus failed on failure", async () => {
    const emitEvent = vi.fn();
    const errorExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "network error", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: errorExecute,
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "失败的任务" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "failed" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  // 6. per-session concurrent limit: rejects 11th task on the same session
  it("rejects new work when the per-session limit (10) is reached", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Dispatch 10 tasks on the same session (fire-and-forget)
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await tool.execute(`call_${i}`, { task: `任务 ${i}` }, null, null, mockCtx()));
    }
    for (const r of results) {
      expect(r.details.streamStatus).toBe("running");
    }

    // 11th task on the same session must be rejected
    const blocked = await tool.execute("call_10", { task: "第十一个任务" }, null, null, mockCtx());
    expect(blocked.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6b. different sessions each get their own per-session quota
  it("allows different sessions to each run up to per-session limit", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Session A: dispatch 10 tasks
    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_a${i}`, { task: `任务 A${i}` }, null, null, mockCtx("/session/a.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session B: should still be able to dispatch 10 tasks (independent quota)
    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_b${i}`, { task: `任务 B${i}` }, null, null, mockCtx("/session/b.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session A: 11th task should be rejected
    const blockedA = await tool.execute("call_a10", { task: "第十一个 A" }, null, null, mockCtx("/session/a.jsonl"));
    expect(blockedA.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blockedA.details).toBeUndefined();

    // Session B: 11th task should also be rejected
    const blockedB = await tool.execute("call_b10", { task: "第十一个 B" }, null, null, mockCtx("/session/b.jsonl"));
    expect(blockedB.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blockedB.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6c. global limit (20) rejects when total across all sessions exceeds it
  it("rejects when global limit (20) is reached across sessions", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Fill up 20 tasks across 4 sessions (5 each, under per-session limit of 8)
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        const r = await tool.execute(`call_${s}_${i}`, { task: `任务` }, null, null, mockCtx(`/session/${s}.jsonl`));
        expect(r.details.streamStatus).toBe("running");
      }
    }

    // 21st task from a new session (per-session is fine, but global is full)
    const blocked = await tool.execute("call_4_0", { task: "第21个" }, null, null, mockCtx("/session/4.jsonl"));
    expect(blocked.content[0].text).toMatch(/20|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  //
  it("lists agents in discovery mode (agent=?)", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: noopExecute,
      listAgents: () => [
        { id: "codia", name: "Codia", model: "claude-3-5-sonnet", summary: "主 agent" },
        { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
      ],
      currentAgentId: "codia",
    }));

    const result = await tool.execute("call_1", { task: "", agent: "?" });

    expect(result.content[0].text).toContain("other-agent");
    expect(result.content[0].text).toContain("Other");
    // self should be excluded
    expect(result.content[0].text).not.toContain("codia (");
    // executeIsolated must not be called in discovery mode
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 8. cross-agent delegation: agentId forwarded in opts
  it("passes agentId to executeIsolated when delegating to another agent", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    const result = await tool.execute("call_1", { task: "专项任务", agent: "other-agent" }, null, null, mockCtx());

    expect(result.details.agentId).toBe("other-agent");
    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "other-agent" }),
    );
  });

  it("passes a snapshot of parent session cwd to async subagent execution", async () => {
    let parentCwd = "/repo/current-subproject";
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      getParentCwd: () => parentCwd,
    }));

    await tool.execute("call_1", { task: "检查当前子项目" }, null, null, mockCtx());
    parentCwd = "/repo/changed-after-dispatch";

    expect(captureExecute).toHaveBeenCalledWith(
      "检查当前子项目",
      expect.objectContaining({ cwd: "/repo/current-subproject" }),
    );
  });

  it("does not grant parent session file reads unless explicitly requested", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "独立检查项目结构" }, null, null, mockCtx("/test/parent.jsonl"));

    expect(captureExecute).toHaveBeenCalledWith(
      "独立检查项目结构",
      expect.objectContaining({ fileReadSessionPaths: [] }),
    );
  });

  it("grants parent session file reads when the model explicitly requests them", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute(
      "call_1",
      { task: "读取当前会话文件后总结", includeSessionFiles: true },
      null,
      null,
      mockCtx("/test/parent.jsonl"),
    );

    expect(captureExecute).toHaveBeenCalledWith(
      "读取当前会话文件后总结",
      expect.objectContaining({ fileReadSessionPaths: ["/test/parent.jsonl"] }),
    );
  });

  it("rejects write access when the parent session is read-only", async () => {
    const captureExecute = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      getSessionPermissionMode: () => "read_only",
    }));

    const result = await tool.execute("call_1", { task: "edit files", access: "write" }, null, null, mockCtx());

    expect(result.details).toMatchObject({ errorCode: "SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY" });
    expect(result.content[0].text).toMatch(/read-only|只读|subagentWriteAccessDenied/i);
    expect(captureExecute).not.toHaveBeenCalled();
    expect(mockStore.defer).not.toHaveBeenCalled();
  });

  it("rejects subagent_reply write access inherited from a thread when the parent session is read-only", async () => {
    const threadStore = makeDeps().getSubagentThreadStore();
    threadStore.get.mockReturnValue({
      threadId: "thread-w",
      kind: "direct",
      status: "open",
      parentSessionPath: "/test/session.jsonl",
      agentId: "other-agent",
      access: "write",
    });
    const captureExecute = makeExecuteIsolated();
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
      getSessionPermissionMode: () => "read_only",
    }));

    const denied = await replyTool.execute("call_1", { threadId: "thread-w", task: "continue editing" }, null, null, mockCtx());

    expect(denied.details).toMatchObject({ errorCode: "SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY" });
    expect(denied.content[0].text).toMatch(/read-only|只读|subagentWriteAccessDenied/i);
    expect(captureExecute).not.toHaveBeenCalled();
    expect(mockStore.defer).not.toHaveBeenCalled();
  });

  it("does not let controller lifecycle hook failures abort subagent dispatch", async () => {
    const lifecycleError = new TypeError("Cannot read properties of undefined (reading 'set')");
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const setSubagentController = vi.fn(() => { throw lifecycleError; });
    const removeSubagentController = vi.fn(() => { throw lifecycleError; });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      setSubagentController,
      removeSubagentController,
    }));

    const result = await tool.execute("call_1", { task: "delegate despite controller hook" }, null, null, mockCtx());

    expect(result.details.errorCode).toBeUndefined();
    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(setSubagentController).toHaveBeenCalledWith(result.details.taskId, expect.any(AbortController));
    expect(captureExecute).toHaveBeenCalledWith(
      "delegate despite controller hook",
      expect.objectContaining({ subagentTaskId: result.details.taskId }),
    );
    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(result.details.taskId, "delegated");
      expect(removeSubagentController).toHaveBeenCalledWith(result.details.taskId);
    });
  });

  it("does not let controller lifecycle hook failures abort subagent_reply", async () => {
    const lifecycleError = new TypeError("Cannot read properties of undefined (reading 'set')");
    const threadStore = makeDeps().getSubagentThreadStore();
    threadStore.get.mockReturnValue({
      threadId: "thread-controller-hook",
      kind: "direct",
      status: "open",
      parentSessionPath: "/test/session.jsonl",
      childSessionPath: "/test/child.jsonl",
      agentId: "other-agent",
      access: "read",
    });
    const captureExecute = makeExecuteIsolated({ replyText: "continued", error: null, sessionPath: "/test/child.jsonl" });
    const setSubagentController = vi.fn(() => { throw lifecycleError; });
    const removeSubagentController = vi.fn(() => { throw lifecycleError; });
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
      setSubagentController,
      removeSubagentController,
    }));

    const result = await replyTool.execute(
      "call_1",
      { threadId: "thread-controller-hook", task: "continue despite controller hook" },
      null,
      null,
      mockCtx(),
    );

    expect(result.details.errorCode).toBeUndefined();
    expect(result.details.threadId).toBe("thread-controller-hook");
    expect(setSubagentController).toHaveBeenCalledWith(result.details.taskId, expect.any(AbortController));
    expect(captureExecute).toHaveBeenCalledWith(
      "continue despite controller hook",
      expect.objectContaining({ subagentTaskId: result.details.taskId }),
    );
    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(result.details.taskId, "continued");
      expect(removeSubagentController).toHaveBeenCalledWith(result.details.taskId);
    });
  });

  // 9. unknown agent returns error without calling executeIsolated
  it("returns error when agent id is unknown", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({ executeIsolated: noopExecute }));

    const result = await tool.execute("call_1", { task: "任务", agent: "nonexistent" });

    // t() falls back to the key when locale is not loaded
    expect(result.content[0].text).toMatch(/agentNotFound|not found|不存在/);
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 10. New direct-thread contract requires deferred + thread store + parent session.
  it("returns a clear error when deferred store is unavailable", async () => {
    const syncExecute = makeExecuteIsolated({ replyText: "sync result", error: null, sessionPath: null });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: syncExecute,
      getDeferredStore: () => null,
      getSessionPath: () => null,
      getParentCwd: () => "/repo/sync-subproject",
    }));

    const result = await tool.execute("call_1", { task: "同步任务" }, null, null, mockCtx());

    expect(result.content[0].text).toBe("子 Agent 需要在当前会话中启动");
    expect(result.details).toMatchObject({ errorCode: "SUBAGENT_PARENT_SESSION_REQUIRED" });
    expect(syncExecute).not.toHaveBeenCalled();
  });

  it("persists stable parent and child session ids for dispatched subagent lifecycle", async () => {
    const runStore = {
      register: vi.fn(),
      attachSession: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
    };
    const threadStore = makeDeps().getSubagentThreadStore();
    const emitEvent = vi.fn();
    const executeIsolated = vi.fn((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl", { sessionId: "sess_child_direct" });
      return Promise.resolve({ replyText: "done", error: null, sessionPath: "/test/child.jsonl" });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
      getSubagentRunStore: () => runStore,
      getSubagentThreadStore: () => threadStore,
      emitEvent,
      getSessionIdForPath: (sessionPath) => sessionPath === "/test/session.jsonl" ? "sess_parent_direct" : null,
    }));

    const result = await tool.execute("call_1", { task: "stable ids" }, null, null, mockCtx());
    const { taskId, threadId } = result.details;

    expect(mockStore.defer).toHaveBeenCalledWith(
      taskId,
      { sessionId: "sess_parent_direct", sessionPath: "/test/session.jsonl" },
      expect.objectContaining({ type: "subagent", summary: "stable ids" }),
    );
    expect(runStore.register).toHaveBeenCalledWith(taskId, expect.objectContaining({
      parentSessionId: "sess_parent_direct",
      parentSessionPath: "/test/session.jsonl",
    }));
    expect(threadStore.beginRun).toHaveBeenCalledWith(threadId, expect.objectContaining({
      parentSessionId: "sess_parent_direct",
      parentSessionPath: "/test/session.jsonl",
    }));

    await vi.waitFor(() => {
      expect(runStore.attachSession).toHaveBeenCalledWith(taskId, "/test/child.jsonl", expect.objectContaining({
        childSessionId: "sess_child_direct",
      }));
      expect(threadStore.attachSession).toHaveBeenCalledWith(threadId, "/test/child.jsonl", expect.objectContaining({
        parentSessionId: "sess_parent_direct",
        parentSessionPath: "/test/session.jsonl",
        childSessionId: "sess_child_direct",
      }));
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ sessionId: "sess_child_direct", streamKey: "/test/child.jsonl" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  it("registers a direct thread before queued execution starts so immediate replies do not become unknown", async () => {
    const threadStore = new SubagentThreadStore();
    vi.spyOn(threadStore, "runSerialized").mockImplementation(() => new Promise(() => {}));
    const executeIsolated = vi.fn();
    const firstStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    };
    const firstTool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => firstStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const first = await firstTool.execute(
      "call_1",
      { task: "first delegated task", agent: "other-agent", access: "read" },
      null,
      null,
      mockCtx(),
    );
    const { threadId } = first.details;

    expect(threadStore.get(threadId)).toMatchObject({
      threadId,
      kind: "direct",
      status: "open",
      lastRunStatus: "pending",
      agentId: "other-agent",
      access: "read",
    });

    const replyStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    };
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => replyStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const reply = await replyTool.execute(
      "call_2",
      { threadId, task: "continue immediately" },
      null,
      null,
      mockCtx(),
    );

    expect(reply.details.errorCode).toBeUndefined();
    expect(reply.details.threadId).toBe(threadId);
    expect(replyStore.defer).toHaveBeenCalledWith(
      reply.details.taskId,
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent", threadId }),
    );
    expect(executeIsolated).not.toHaveBeenCalled();
  });

  it("allows subagent_reply when parent session path moved but stable session id matches", async () => {
    const threadStore = makeDeps().getSubagentThreadStore();
    threadStore.get.mockReturnValue({
      threadId: "thread-stable",
      kind: "direct",
      status: "open",
      parentSessionId: "sess_parent_direct",
      parentSessionPath: "/test/archive/session.jsonl",
      childSessionId: "sess_child_direct",
      childSessionPath: "/test/child.jsonl",
      agentId: "codia",
      access: "read",
    });
    const runStore = { register: vi.fn(), attachSession: vi.fn(), resolve: vi.fn(), fail: vi.fn(), abort: vi.fn() };
    const replyTool = createSubagentReplyTool(makeDeps({
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
      getSubagentRunStore: () => runStore,
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/test/session.jsonl" || sessionPath === "/test/archive/session.jsonl"
          ? "sess_parent_direct"
          : null
      ),
    }));

    const result = await replyTool.execute("call_1", { threadId: "thread-stable", task: "continue" }, null, null, mockCtx());

    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(result.details.errorCode).toBeUndefined();
    expect(mockStore.defer).toHaveBeenCalledWith(
      result.details.taskId,
      { sessionId: "sess_parent_direct", sessionPath: "/test/session.jsonl" },
      expect.objectContaining({ type: "subagent", threadId: "thread-stable" }),
    );
    expect(runStore.register).toHaveBeenCalledWith(result.details.taskId, expect.objectContaining({
      parentSessionId: "sess_parent_direct",
      parentSessionPath: "/test/session.jsonl",
    }));
  });

  it("allows subagent_close when parent session path moved but stable session id matches", async () => {
    const threadStore = makeDeps().getSubagentThreadStore();
    const closedThread = {
      threadId: "thread-stable",
      kind: "direct",
      status: "closed",
      parentSessionId: "sess_parent_direct",
      parentSessionPath: "/test/archive/session.jsonl",
      childSessionId: "sess_child_direct",
      childSessionPath: "/test/child.jsonl",
    };
    threadStore.get.mockReturnValue({
      ...closedThread,
      status: "open",
    });
    threadStore.closeDirectThread.mockReturnValue(closedThread);
    const closeTool = createSubagentCloseTool(makeDeps({
      getSubagentThreadStore: () => threadStore,
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/test/session.jsonl" || sessionPath === "/test/archive/session.jsonl"
          ? "sess_parent_direct"
          : null
      ),
    }));

    const result = await closeTool.execute("call_1", { threadId: "thread-stable" }, null, null, mockCtx());

    expect(result.details).toMatchObject({
      threadId: "thread-stable",
      streamStatus: "closed",
      childSessionId: "sess_child_direct",
      childSessionPath: "/test/child.jsonl",
    });
    expect(threadStore.closeDirectThread).toHaveBeenCalledWith("thread-stable", expect.any(Object));
  });
});
