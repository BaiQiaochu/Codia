// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySessionPermission } from "../core/session-permission-mode.js";
import { createCurrentStatusTool } from "../lib/tools/current-status-tool.js";

function textPayload(result) {
  return JSON.parse(result.content[0].text);
}

function makeCtx(sessionPath = "/tmp/agents/codia/sessions/s1.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-current-status-"));
  tempDirs.push(dir);
  return dir;
}

function writeAvatar(baseDir, role, content = `${role}-avatar`) {
  const dir = path.join(baseDir, "avatars");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${role}.png`);
  fs.writeFileSync(filePath, Buffer.from(content));
  return filePath;
}

describe("current_status tool", () => {
  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("describes time and logical_date as distinct lookup contracts", () => {
    const tool = createCurrentStatusTool();

    expect(tool.description).toContain('key="time"');
    expect(tool.description).toContain("hour/minute");
    expect(tool.description).toContain('key="logical_date"');
    expect(tool.description).toContain("does not return hour/minute/second");
  });

  it("lists available status keys without returning live status values", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
      getAgent: () => ({ id: "codia", agentName: "Codia" }),
      getSessionModel: () => ({ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "list" }));

    expect(payload.available.map((item) => item.key)).toEqual([
      "time",
      "logical_date",
      "agent",
      "appearance",
      "model",
      "ui_context",
      "session_files",
      "bridge_context",
      "subagents",
    ]);
    expect(payload.usage).toContain("list");
    expect(payload.usage).toContain("get");
    expect(JSON.stringify(payload)).not.toContain("Codia");
    expect(JSON.stringify(payload)).not.toContain("claude-sonnet-4-5");
    expect(JSON.stringify(payload)).not.toContain("2026-05-03T19:30:00.000Z");
  });

  it("returns only time fields for get time", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
      getAgent: () => ({ id: "codia", agentName: "Codia" }),
      getSessionModel: () => ({ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "time" }, null, null, makeCtx()));

    expect(payload).toEqual({
      time: {
        iso: "2026-05-03T19:30:00.000Z",
        timezone: "Asia/Shanghai",
        localDateTime: "2026-05-04 03:30:00",
        utcOffset: "+08:00",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("Codia");
    expect(JSON.stringify(payload)).not.toContain("claude-sonnet-4-5");
  });

  it("computes logical date in the configured timezone with the 4am boundary", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "logical_date" }));

    expect(payload).toEqual({
      logical_date: {
        date: "2026-05-03",
        timezone: "Asia/Shanghai",
        dayBoundaryHour: 4,
      },
    });
  });

  it("returns only agent fields for get agent", async () => {
    const tool = createCurrentStatusTool({
      getAgent: () => ({ id: "codia", agentName: "Codia" }),
      now: () => new Date("2026-05-03T19:30:00.000Z"),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "agent" }));

    expect(payload).toEqual({
      agent: {
        id: "codia",
        name: "Codia",
      },
    });
  });

  it("returns direct avatar image blocks for appearance when the current model supports images", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "codia");
    writeAvatar(userDir, "user", "user image bytes");
    writeAvatar(agentDir, "agent", "agent image bytes");

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "codia",
        agentName: "Codia",
        userName: "Sample User",
        userDir,
        agentDir,
      }),
      getCurrentModel: () => ({ id: "gpt-4o", provider: "openai", input: ["text", "image"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(payload.appearance.mode).toBe("direct_image");
    expect(payload.appearance.user.directImage).toMatchObject({ included: true, contentIndex: 1 });
    expect(payload.appearance.agent.directImage).toMatchObject({ included: true, contentIndex: 2 });
    expect(result.content.slice(1)).toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from("user image bytes").toString("base64") },
      { type: "image", mimeType: "image/png", data: Buffer.from("agent image bytes").toString("base64") },
    ]);
    expect(result.content[0].text).not.toContain(userDir);
    expect(result.content[0].text).not.toContain(agentDir);
    expect(result.content[0].text).not.toContain(Buffer.from("user image bytes").toString("base64"));
  });

  it("returns no appearance image when only the built-in default avatar exists", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "codia");
    fs.mkdirSync(path.join(root, "desktop", "src", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "desktop", "src", "assets", "codia.png"), Buffer.from("default-avatar"));

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "codia",
        agentName: "Codia",
        userName: "User",
        userDir,
        agentDir,
        productDir: root,
        config: { agent: { name: "Codia", yuan: "codia" } },
      }),
      getCurrentModel: () => ({ id: "gpt-4o", provider: "openai", input: ["text", "image"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("unavailable");
    expect(payload.appearance.agent.avatar.available).toBe(false);
    expect(payload.appearance.agent.summary).toBeNull();
    expect(payload.appearance.agent.directImage.included).toBe(false);
  });

  it("returns explicit unavailable appearance when avatars exist but neither auxiliary vision nor direct image input is available", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "codia");
    writeAvatar(userDir, "user", "user image bytes");
    writeAvatar(agentDir, "agent", "agent image bytes");

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "codia",
        agentName: "Codia",
        userName: "Sample User",
        userDir,
        agentDir,
      }),
      getCurrentModel: () => ({ id: "deepseek-chat", provider: "deepseek", input: ["text"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("unavailable");
    expect(payload.appearance.user.avatar.available).toBe(true);
    expect(payload.appearance.user.summary).toBeNull();
    expect(payload.appearance.user.vision.status).toBe("not_configured");
    expect(payload.appearance.user.directImage.included).toBe(false);
    expect(payload.appearance.agent.avatar.available).toBe(true);
    expect(payload.appearance.agent.summary).toBeNull();
    expect(payload.appearance.agent.vision.status).toBe("not_configured");
    expect(payload.appearance.agent.directImage.included).toBe(false);
  });

  it("summarizes custom avatar appearance through the auxiliary vision bridge when available", async () => {
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    const agentDir = path.join(root, "agents", "codia");
    writeAvatar(userDir, "user", "user image bytes");
    writeAvatar(agentDir, "agent", "agent image bytes");
    const summarizeResources = vi.fn(async ({ resources }) => ({
      notes: resources.map((resource) => ({
        key: resource.key,
        label: resource.label,
        note: `${resource.label}: calm portrait summary`,
        reused: false,
      })),
    }));

    const tool = createCurrentStatusTool({
      getAgent: () => ({
        id: "codia",
        agentName: "Codia",
        userName: "Sample User",
        userDir,
        agentDir,
      }),
      getVisionBridge: () => ({ summarizeResources }),
      getCurrentModel: () => ({ id: "deepseek-chat", provider: "deepseek", input: ["text"] }),
    });

    const result = await tool.execute("call_1", { action: "get", key: "appearance" }, null, null, makeCtx());
    const payload = textPayload(result);

    expect(summarizeResources).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/agents/codia/sessions/s1.jsonl",
      userRequest: expect.stringContaining("appearance"),
      resources: [
        expect.objectContaining({ label: "user custom avatar" }),
        expect.objectContaining({ label: "agent custom avatar" }),
      ],
    }));
    expect(result.content).toHaveLength(1);
    expect(payload.appearance.mode).toBe("vision_summary");
    expect(payload.appearance.user.summary).toContain("user custom avatar: calm portrait summary");
    expect(payload.appearance.agent.summary).toContain("agent custom avatar: calm portrait summary");
  });

  it("returns the current session model for get model", async () => {
    const tool = createCurrentStatusTool({
      getSessionModel: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }
        : null,
      getCurrentModel: () => ({ id: "fallback", provider: "openai", name: "Fallback" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "model" }, null, null, makeCtx()));

    expect(payload).toEqual({
      model: {
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        name: "Claude Sonnet 4.5",
      },
    });
  });

  it("returns passive UI context metadata for get ui_context", async () => {
    const tool = createCurrentStatusTool({
      getUiContext: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? {
            currentViewed: "/workspace/notes",
            activeFile: "/workspace/notes/diary.md",
            activePreview: null,
            pinnedFiles: ["/workspace/spec.md"],
          }
        : null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "ui_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      ui_context: {
        currentViewed: "/workspace/notes",
        activeFile: "/workspace/notes/diary.md",
        activePreview: null,
        pinnedFiles: ["/workspace/spec.md"],
      },
    });
  });

  it("returns an empty UI context shape when no visible UI context is stored", async () => {
    const tool = createCurrentStatusTool({
      getUiContext: () => null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "ui_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      ui_context: {
        currentViewed: null,
        activeFile: null,
        activePreview: null,
        pinnedFiles: [],
      },
    });
  });

  it("returns normalized current session files for get session_files", async () => {
    const tool = createCurrentStatusTool({
      listSessionFiles: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? [
            {
              id: "sf_browser",
              fileId: "sf_browser",
              sessionPath,
              filePath: "/tmp/session-files/browser-screenshot.jpg",
              realPath: "/private/tmp/session-files/browser-screenshot.jpg",
              label: "browser-screenshot.jpg",
              displayName: "Browser Screenshot",
              filename: "browser-screenshot.jpg",
              ext: "jpg",
              mime: "image/jpeg",
              kind: "image",
              size: 12345,
              origin: "browser_screenshot",
              operations: ["captured"],
              storageKind: "managed_cache",
              status: "available",
              missingAt: null,
              createdAt: 1778432852184,
              isDirectory: false,
              internalOnly: "must not leak",
            },
          ]
        : [],
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "session_files" }, null, null, makeCtx()));

    expect(payload).toEqual({
      session_files: {
        sessionPath: "/tmp/agents/codia/sessions/s1.jsonl",
        registryAvailable: true,
        files: [{
          fileId: "sf_browser",
          sessionFileRef: {
            kind: "session-file",
            fileId: "sf_browser",
          },
          writableLocalRef: null,
          label: "browser-screenshot.jpg",
          displayName: "Browser Screenshot",
          filename: "browser-screenshot.jpg",
          ext: "jpg",
          kind: "image",
          mime: "image/jpeg",
          size: 12345,
          origin: "browser_screenshot",
          operations: ["captured"],
          storageKind: "managed_cache",
          status: "available",
          missingAt: null,
          createdAt: 1778432852184,
          isDirectory: false,
          filePath: "/tmp/session-files/browser-screenshot.jpg",
          realPath: "/private/tmp/session-files/browser-screenshot.jpg",
        }],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("internalOnly");
  });

  it("returns bridge context for the current session when available", async () => {
    const tool = createCurrentStatusTool({
      getBridgeContext: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? {
            isBridgeSession: true,
            platform: "wechat",
            platformLabel: "WeChat",
            chatType: "dm",
            role: "owner",
            sessionKey: "wx_dm_owner@codia",
            notificationHint: {
              channels: ["bridge_owner"],
              bridgePlatforms: ["wechat"],
              contextPolicy: "record_when_delivered",
            },
          }
        : null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "bridge_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      bridge_context: {
        isBridgeSession: true,
        platform: "wechat",
        platformLabel: "WeChat",
        chatType: "dm",
        role: "owner",
        sessionKey: "wx_dm_owner@codia",
        agentId: null,
        userId: null,
        chatId: null,
        notificationHint: {
          channels: ["bridge_owner"],
          bridgePlatforms: ["wechat"],
          contextPolicy: "record_when_delivered",
        },
      },
    });
  });

  it("returns an explicit non-bridge shape outside Bridge sessions", async () => {
    const tool = createCurrentStatusTool({
      getBridgeContext: () => null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "bridge_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      bridge_context: {
        isBridgeSession: false,
      },
    });
  });

  it("returns open direct subagent instances for the current session", async () => {
    const tool = createCurrentStatusTool({
      listOpenSubagentThreads: (sessionPath) => sessionPath === "/session/s1.jsonl"
        ? [{
            threadId: "thread-a",
            agentId: "other-agent",
            agentName: "Worker",
            label: "research",
            access: "read",
            status: "open",
            lastRunStatus: "resolved",
            childSessionPath: "/child/a.jsonl",
            summary: "read lifecycle code",
            runCount: 2,
            lastRunAt: "2026-06-02T10:00:00.000Z",
            updatedAt: "2026-06-02T10:01:00.000Z",
          }]
        : [],
    });

    const payload = textPayload(await tool.execute(
      "call_1",
      { action: "get", key: "subagents" },
      null,
      null,
      makeCtx("/session/s1.jsonl"),
    ));

    expect(payload).toEqual({
      subagents: {
        sessionPath: "/session/s1.jsonl",
        open: [{
          threadId: "thread-a",
          agentId: "other-agent",
          agentName: "Worker",
          label: "research",
          access: "read",
          status: "open",
          lastRunStatus: "resolved",
          childSessionPath: "/child/a.jsonl",
          summary: "read lifecycle code",
          runCount: 2,
          lastRunAt: "2026-06-02T10:00:00.000Z",
          updatedAt: "2026-06-02T10:01:00.000Z",
        }],
      },
    });
  });

  it("returns a clear error for unknown keys", async () => {
    const tool = createCurrentStatusTool();

    const result = await tool.execute("call_1", { action: "get", key: "session_path" });

    expect(result.content[0].text).toContain("Unknown status key");
    expect(result.details.errorCode).toBe("UNKNOWN_STATUS_KEY");
  });

  it("is allowed in read-only permission mode", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "current_status" }))
      .toEqual({ action: "allow" });
  });
});
