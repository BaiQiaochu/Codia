// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

const { runAgentPhoneSessionMock, callTextMock } = vi.hoisted(() => ({
  runAgentPhoneSessionMock: vi.fn(async () => ""),
  callTextMock: vi.fn(async () => "YES"),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentSession: vi.fn(async () => "legacy text"),
  runAgentPhoneSession: runAgentPhoneSessionMock,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: callTextMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { ChannelRouter } from "../hub/channel-router.js";
import { parseChannel } from "../lib/channels/channel-store.js";
import { loadLocale } from "../server/i18n.js";

describe("ChannelRouter channel reply tool boundary", () => {
  it("runs channel phone delivery with channel-scoped decision tools", async () => {
    runAgentPhoneSessionMock.mockClear();
    callTextMock.mockClear();

    const engine = {
      marker: "engine",
      channelsDir: "/fake/channels",
      agentsDir: "/fake/agents",
      getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
    };
    const router = new ChannelRouter({
      hub: {
        engine,
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeReply(
      "codia",
      "ch_crew",
      "user: @Codia please reply OK",
    );

    expect(result).toMatchObject({ replied: false, missingDecision: true });
    expect(runAgentPhoneSessionMock).toHaveBeenCalledOnce();
    const options = runAgentPhoneSessionMock.mock.calls[0][2];
    expect(options).toMatchObject({
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      toolMode: "read_only",
      emitEvents: true,
    });
    expect(options.extraCustomTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["channel_read_context", "channel_reply", "channel_pass"]),
    );
    expect(callTextMock).not.toHaveBeenCalled();
  });

  it("tells project managers to use company_assign for channel task dispatch", async () => {
    runAgentPhoneSessionMock.mockClear();
    loadLocale("en");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-router-company-assign-guidance-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "pm-1"), { recursive: true });
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), [
      "---",
      "id: ch_crew",
      "members: [pm-1, worker-1]",
      "member_roles: [pm-1=project_manager, worker-1=worker]",
      "---",
      "",
    ].join("\n"), "utf-8");

    const assignTool = {
      name: "company_assign",
      description: "assign tasks",
      parameters: {},
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    };
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          pluginManager: {
            getPluginTool: vi.fn(() => assignTool),
          },
          getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeReply(
      "pm-1",
      "ch_crew",
      "user: please split this project and assign the implementation work",
      "Your team role in #ch_crew is: project_manager.",
    );

    const prompt = runAgentPhoneSessionMock.mock.calls[0][1][0].text;
    const options = runAgentPhoneSessionMock.mock.calls[0][2];
    expect(options.extraCustomTools.map((tool) => tool.name)).toContain("company_assign");
    expect(prompt).toContain("company_assign");
    expect(prompt).toContain("posts task cards into the current channel");
    expect(prompt).toContain("Do not only simulate dispatch in ordinary text");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("posts only the channel_reply tool content and ignores raw model text", async () => {
    runAgentPhoneSessionMock.mockClear();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-router-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    const generatedFile = path.join(root, "result.png");
    const generatedAudio = path.join(root, "voice.mp3");
    const phoneSessionPath = path.join(agentsDir, "codia", "phone", "sessions", "ch_crew", "phone.jsonl");
    runAgentPhoneSessionMock.mockImplementationOnce(async (_agentId, _rounds, options) => {
      options.onEvent?.({
        type: "tool_execution_end",
        toolName: "stage_files",
        isError: false,
        result: {
          details: {
            files: [
              { filePath: generatedFile, label: "result.png", ext: "png" },
              { filePath: generatedAudio, label: "voice.mp3", ext: "mp3" },
            ],
          },
        },
      }, { sessionPath: phoneSessionPath });
      const replyTool = options.extraCustomTools.find((tool) => tool.name === "channel_reply");
      await replyTool.execute("tool-call-1", {
        mood: "private reflection",
        content: "工具发送的 OK",
      });
      return "RAW MODEL TEXT SHOULD NOT BE POSTED";
    });

    fs.mkdirSync(path.join(agentsDir, "codia"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "codia", "config.yaml"), "agent:\n  name: Codia\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [codia]\n---\n", "utf-8");

    const emit = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
          getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
        },
        eventBus: { emit },
      },
    });

    const result = await router._executeCheck(
      "codia",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "@Codia ping" }],
      [],
    );

    expect(result.replied).toBe(true);
    expect(result.replyContent).toBe("工具发送的 OK");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "channel_new_message",
      channelName: "ch_crew",
      sender: "codia",
        message: expect.objectContaining({
          sender: "codia",
          body: "工具发送的 OK",
          blocks: [expect.objectContaining({
            type: "file",
            filePath: generatedFile,
            label: "result.png",
            ext: "png",
            sessionPath: phoneSessionPath,
          }), expect.objectContaining({
            type: "file",
            filePath: generatedAudio,
            label: "voice.mp3",
            ext: "mp3",
            sessionPath: phoneSessionPath,
          })],
        }),
      }), null);
    const channelRaw = fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8");
    expect(channelRaw).toContain("工具发送的 OK");
    expect(channelRaw).not.toContain("RAW MODEL TEXT SHOULD NOT BE POSTED");
    const parsed = parseChannel(channelRaw);
    expect(parsed.messages.at(-1)?.blocks).toEqual([
      expect.objectContaining({
        type: "file",
        filePath: generatedFile,
        label: "result.png",
        ext: "png",
        sessionPath: phoneSessionPath,
      }),
      expect.objectContaining({
        type: "file",
        filePath: generatedAudio,
        label: "voice.mp3",
        ext: "mp3",
        sessionPath: phoneSessionPath,
      }),
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("routes completed image generation results into the channel reply blocks", async () => {
    runAgentPhoneSessionMock.mockClear();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-router-image-result-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const generatedFile = path.join(root, "generated.png");
    const phoneSessionPath = path.join(agentsDir, "codia", "phone", "sessions", "ch_crew", "phone.jsonl");

    runAgentPhoneSessionMock.mockImplementationOnce(async (_agentId, _rounds, options) => {
      options.onEvent?.({
        type: "tool_execution_end",
        toolName: "image-gen_generate-image",
        isError: false,
        result: {
          details: {
            mediaGeneration: {
              kind: "image",
              prompt: "city over clouds",
              tasks: [{ taskId: "image-task-1" }],
            },
          },
        },
      }, { sessionPath: phoneSessionPath });
      const replyTool = options.extraCustomTools.find((tool) => tool.name === "channel_reply");
      await replyTool.execute("tool-call-image", {
        content: "图片已完成",
      });
      return "";
    });

    fs.mkdirSync(path.join(agentsDir, "codia"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "codia", "config.yaml"), "agent:\n  name: Codia\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [codia]\n---\n", "utf-8");

    const emit = vi.fn();
    const deferredResults = {
      query: vi.fn((taskId) => taskId === "image-task-1"
        ? {
            status: "resolved",
            meta: { type: "image-generation" },
            result: {
              sessionFiles: [{
                id: "sf-generated",
                filePath: generatedFile,
                label: "generated.png",
                ext: "png",
                mime: "image/png",
                kind: "image",
              }],
            },
          }
        : null),
    };
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          deferredResults,
          isChannelsEnabled: () => true,
          getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
        },
        eventBus: { emit },
      },
    });

    const result = await router._executeCheck(
      "codia",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-06-03 17:00:00", body: "@Codia 生成图片" }],
      [],
    );

    expect(result.replied).toBe(true);
    expect(deferredResults.query).toHaveBeenCalledWith("image-task-1");
    const expectedBlock = expect.objectContaining({
      type: "file",
      replacesTaskId: "image-task-1",
      fileId: "sf-generated",
      filePath: generatedFile,
      label: "generated.png",
      ext: "png",
      mime: "image/png",
      kind: "image",
      sessionPath: phoneSessionPath,
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "channel_new_message",
      message: expect.objectContaining({
        body: "图片已完成",
        blocks: [expectedBlock],
      }),
    }), null);
    const parsed = parseChannel(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8"));
    expect(parsed.messages.at(-1)?.blocks).toEqual([expectedBlock]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("includes channel member roles in phone delivery so assistants cooperate by responsibility", async () => {
    runAgentPhoneSessionMock.mockClear();
    loadLocale("en");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-router-roles-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "pm-1"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), [
      "---",
      "id: ch_crew",
      "members: [pm-1, worker-1]",
      "member_roles: [pm-1=project_manager, worker-1=worker]",
      "---",
      "",
    ].join("\n"), "utf-8");

    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeCheck(
      "pm-1",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-22 12:00:00", body: "please coordinate this" }],
      [],
    );

    const prompt = runAgentPhoneSessionMock.mock.calls[0][1][0].text;
    expect(prompt).toContain("Your team role in #ch_crew is: Project manager (project_manager).");
    expect(prompt).toContain("- worker-1: worker");
    expect(prompt).toContain("coordinate assignments");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats mentioned company task posts as executable channel assignments", async () => {
    runAgentPhoneSessionMock.mockClear();
    loadLocale("en");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-router-company-task-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "worker-1"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), [
      "---",
      "id: ch_crew",
      "members: [pm-1, worker-1]",
      "member_roles: [pm-1=project_manager, worker-1=worker]",
      "---",
      "",
    ].join("\n"), "utf-8");

    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeCheck(
      "worker-1",
      "ch_crew",
      [{
        sender: "Project Manager",
        timestamp: "2026-05-29 12:00:00",
        body: "Company tasks assigned:\n- @worker-1: Draft the implementation plan",
      }],
      [],
      { mentionedAgents: ["worker-1"], mentionTargeted: true },
    );

    const prompt = runAgentPhoneSessionMock.mock.calls[0][1][0].text;
    expect(prompt).toContain("company task card");
    expect(prompt).toContain("Do not claim the company plugin cannot dispatch agents");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps worker phone turns on execution/reporting instead of task-tree dispatch", async () => {
    runAgentPhoneSessionMock.mockClear();
    loadLocale("en");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-channel-router-worker-role-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "worker-1"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), [
      "---",
      "id: ch_crew",
      "members: [pm-1, admin-1, worker-1]",
      "member_roles: [pm-1=project_manager, admin-1=admin, worker-1=worker]",
      "---",
      "",
    ].join("\n"), "utf-8");

    const assignTool = {
      name: "company_assign",
      description: "assign tasks",
      parameters: {},
      execute: vi.fn(),
    };
    const reportTool = {
      name: "company_report",
      description: "report tasks",
      parameters: {},
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "reported" }] })),
    };
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          pluginManager: {
            getPluginTool: vi.fn((_pluginId, toolName) => {
              if (toolName === "assign") return assignTool;
              if (toolName === "report") return reportTool;
              return null;
            }),
          },
          getAgent: () => ({ config: { agent: { yuan: "codia" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeCheck(
      "worker-1",
      "ch_crew",
      [{ sender: "pm-1", timestamp: "2026-06-02 10:00:00", body: "@worker-1 please implement this task" }],
      [],
      { mentionedAgents: ["worker-1"], mentionTargeted: true },
    );

    const prompt = runAgentPhoneSessionMock.mock.calls[0][1][0].text;
    const options = runAgentPhoneSessionMock.mock.calls[0][2];
    expect(options.extraCustomTools.map((tool) => tool.name)).not.toContain("company_assign");
    expect(options.extraCustomTools.map((tool) => tool.name)).toContain("company_report");
    expect(prompt).toContain("Your team role in #ch_crew is: Worker (worker).");
    expect(prompt).toContain("Current channel dispatch chain");
    expect(prompt).toContain("call company_report first");
    expect(prompt).not.toContain("If this turn asks you to split a project");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
