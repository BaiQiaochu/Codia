// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { createAutomationTool } from "../lib/tools/automation-tool.js";
import { buildBridgeContext } from "../lib/bridge/bridge-context.ts";

function makeStore(initialJobs = [], id = "studio_job_1") {
  return {
    addJob: vi.fn((jobData) => ({ ...jobData, id, enabled: true })),
    updateJob: vi.fn((jobId, fields) => ({
      ...initialJobs.find((job) => job.id === jobId),
      ...fields,
      id: jobId,
    })),
    getJob: vi.fn((jobId) => initialJobs.find((job) => job.id === jobId) || null),
    listJobs: vi.fn(() => initialJobs),
  };
}

function deferredDecision() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeSuggestionStore(id = "automation_suggestion_1", shortCode = "3827") {
  const created: any[] = [];
  const store = {
    create: vi.fn((entry) => {
      const suggestion = { ...entry, suggestionId: id, shortCode };
      created.push(suggestion);
      return suggestion;
    }),
  };
  return { store, created };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("automation tool", () => {
  it("creates Agent-run automation suggestions instead of confirm-store drafts by default", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore();
    const confirmStore = { create: vi.fn() };
    const tool = createAutomationTool(store, {
      confirmStore,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => ["/workspace/ref"],
      getHomeCwd: (agentId) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_suggestion",
      {
        action: "create",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes and send a short summary.",
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => "/sessions/agent-a.jsonl",
          getCwd: () => "/workspace/current",
        },
        bridgeContext: {
          isBridgeSession: true,
          sessionKey: "wechat_dm_owner@agent-a",
          platform: "wechat",
        },
      },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(suggestionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/sessions/agent-a.jsonl",
      bridgeSessionKey: "wechat_dm_owner@agent-a",
      operation: "create",
      jobData: expect.objectContaining({
        label: "Morning Review",
        actorAgentId: "agent-b",
      }),
      apply: expect.any(Function),
    }));
    expect(result.details).toMatchObject({
      action: "pending_add",
      operation: "create",
      suggestionId: "automation_suggestion_1",
      suggestionShortCode: "3827",
      automationSuggestion: {
        suggestionId: "automation_suggestion_1",
        shortCode: "3827",
        operation: "create",
      },
    });
    expect("confirmId" in result.details).toBe(false);
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("tells text-command bridge users to apply automation suggestions with /apply", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_suggestion_wx", "3827");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_wechat",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      undefined,
      undefined,
      {
        sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" },
        bridgeContext: buildBridgeContext({
          sessionKey: "wx_dm_owner@agent-a",
          role: "owner",
        }, "en"),
      },
    );

    const text = result.content[0].text;
    expect(text).toContain("/apply");
    expect(text).toContain("3827");
    expect(text).toContain("text-only");
    expect(text).not.toContain("/confirm");
    expect(text).not.toMatch(/click|button|card/i);
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("keeps pending suggestion semantics when no suggestion store is available", async () => {
    const store = makeStore();
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_inline",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 8 * * *",
        label: "Breakfast",
        prompt: "eat breakfast",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(result.details).toMatchObject({
      action: "pending_add",
      suggestionId: "",
      suggestionShortCode: "",
    });
    expect("confirmId" in result.details).toBe(false);
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("describes create/update as deferred drafts unless auto approve is enabled", () => {
    const deferredTool = createAutomationTool(makeStore(), {
      getAutoApprove: () => false,
    });
    const directCommitTool = createAutomationTool(makeStore(), {
      getAutoApprove: () => true,
    });

    expect(deferredTool.sessionPermission.describeSideEffect({ action: "create" })).toMatchObject({
      kind: "deferred_mutation_draft",
      commit: "requires_user_confirmation",
      ruleId: "automation-draft-no-write",
    });
    expect(deferredTool.sessionPermission.describeSideEffect({ action: "update" })).toMatchObject({
      kind: "deferred_mutation_draft",
      commit: "requires_user_confirmation",
      ruleId: "automation-draft-no-write",
    });
    expect(deferredTool.sessionPermission.describeSideEffect({ action: "list" })).toBeNull();
    expect(directCommitTool.sessionPermission.describeSideEffect({ action: "create" })).toBeNull();
  });

  it("creates Agent-run automation drafts and writes only after confirmation", async () => {
    const store = makeStore();
    const decision = deferredDecision();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_1",
        promise: decision.promise,
      })),
    };
    const tool = createAutomationTool(store, {
      confirmStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => ["/workspace/ref"],
      getHomeCwd: (agentId) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_1",
      {
        action: "create",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes and send a short summary.",
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => "/sessions/agent-a.jsonl",
          getCwd: () => "/workspace/current",
        },
      },
    );

    expect(confirmStore.create).toHaveBeenCalledWith(
      "cron",
      expect.objectContaining({
        operation: "create",
        jobData: expect.objectContaining({
          label: "Morning Review",
          actorAgentId: "agent-b",
        }),
      }),
      "/sessions/agent-a.jsonl",
    );
    expect(result.details).toMatchObject({
      action: "pending_add",
      operation: "create",
      confirmId: "confirm_1",
    });
    expect(store.addJob).not.toHaveBeenCalled();

    decision.resolve({ action: "confirmed" });
    await flushMicrotasks();

    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "Review my notes and send a short summary.",
      label: "Morning Review",
      actorAgentId: "agent-b",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-b",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-b",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "Review my notes and send a short summary.",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-b",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/agent-a.jsonl",
          createdByAgentId: "agent-b",
        },
      },
      createdBy: {
        kind: "agent",
        agentId: "agent-b",
        sourceSessionPath: "/sessions/agent-a.jsonl",
      },
    }));
  });

  it("uses edited draft fields when the confirmation card is approved", async () => {
    const store = makeStore();
    const decision = deferredDecision();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_2",
        promise: decision.promise,
      })),
    };
    const tool = createAutomationTool(store, {
      confirmStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId) => `/home/${agentId}`,
    });

    await tool.execute(
      "call_2",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        prompt: "original prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    decision.resolve({
      action: "confirmed",
      value: {
        jobData: {
          label: "Edited Reminder",
          schedule: "30 10 * * *",
          prompt: "edited agent run prompt",
          actorAgentId: "agent-b",
          executionContext: {
            kind: "session_workspace",
            cwd: "/home/agent-b",
            workspaceFolders: [],
            sourceSessionPath: "/sessions/agent-a.jsonl",
            createdByAgentId: "agent-b",
          },
        },
      },
    });
    await flushMicrotasks();

    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      label: "Edited Reminder",
      schedule: "30 10 * * *",
      prompt: "edited agent run prompt",
      actorAgentId: "agent-b",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-b",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-b",
      },
      executor: expect.objectContaining({
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "edited agent run prompt",
      }),
    }));
  });

  it("updates existing automations only after the update draft is confirmed", async () => {
    const existingJob = {
      id: "studio_job_9",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "old prompt",
      label: "Old automation",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "old prompt",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/agent-a.jsonl",
          createdByAgentId: "agent-a",
        },
      },
    };
    const store = makeStore([existingJob]);
    const decision = deferredDecision();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_update",
        promise: decision.promise,
      })),
    };
    const tool = createAutomationTool(store, {
      confirmStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_update",
      {
        action: "update",
        id: "studio_job_9",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "30 12 * * *",
        label: "Lunch automation",
        prompt: "new prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(result.details).toMatchObject({
      action: "pending_update",
      operation: "update",
      confirmId: "confirm_update",
      jobData: expect.objectContaining({
        id: "studio_job_9",
        actorAgentId: "agent-b",
      }),
    });
    expect(store.updateJob).not.toHaveBeenCalled();

    decision.resolve({ action: "confirmed" });
    await flushMicrotasks();

    expect(store.updateJob).toHaveBeenCalledWith("studio_job_9", expect.objectContaining({
      type: "cron",
      schedule: "30 12 * * *",
      label: "Lunch automation",
      prompt: "new prompt",
      actorAgentId: "agent-b",
      executor: expect.objectContaining({
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "new prompt",
      }),
    }));
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("preserves existing fields when an update draft only changes the schedule", async () => {
    const existingJob = {
      id: "studio_job_keep_fields",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "send the daily note",
      label: "Daily note",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/agent-a.jsonl",
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "send the daily note",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/agent-a.jsonl",
          createdByAgentId: "agent-a",
        },
      },
    };
    const store = makeStore([existingJob]);
    const decision = deferredDecision();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_keep_fields",
        promise: decision.promise,
      })),
    };
    const tool = createAutomationTool(store, {
      confirmStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId) => `/home/${agentId}`,
    });

    await tool.execute(
      "call_update_keep_fields",
      {
        action: "update",
        id: "studio_job_keep_fields",
        scheduleType: "cron",
        schedule: "30 9 * * *",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    decision.resolve({ action: "confirmed" });
    await flushMicrotasks();

    expect(store.updateJob).toHaveBeenCalledWith("studio_job_keep_fields", expect.objectContaining({
      schedule: "30 9 * * *",
      label: "Daily note",
      prompt: "send the daily note",
      actorAgentId: "agent-a",
    }));
  });

  it("creates immediately only when auto approve is explicitly enabled", async () => {
    const store = makeStore();
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm_3",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const tool = createAutomationTool(store, {
      getAutoApprove: () => true,
      confirmStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    await tool.execute(
      "call_3",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        prompt: "prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/sessions/agent-a.jsonl" } },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(store.addJob).toHaveBeenCalledOnce();
  });

  it("rejects removed legacy automation actions", async () => {
    const store = makeStore();
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_4",
      {
        action: "add_file_create",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        relativePath: "notes/today.md",
        content: "# Today\n",
      },
      undefined,
      undefined,
      {},
    );

    expect(result.details).toMatchObject({
      action: "add_file_create",
      error: "unknown automation action: add_file_create",
    });
    expect(store.addJob).not.toHaveBeenCalled();
  });
});
