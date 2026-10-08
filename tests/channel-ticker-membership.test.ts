// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannel, appendMessage } from "../lib/channels/channel-store.js";
import { buildChannelUnreadDeliveryWindow, createChannelTicker } from "../lib/channels/channel-ticker.js";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channel-ticker-"));
}

describe("channel-ticker membership delivery", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("caps missing-bookmark unread delivery at the most recent 20 messages", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["gsap", "yui"],
    });
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    for (let i = 1; i <= 25; i += 1) {
      await appendMessage(channelFile, "user", `message ${i}`);
    }

    const window = buildChannelUnreadDeliveryWindow({
      channelFile,
      bookmark: undefined,
      agentId: "gsap",
    });

    expect(window.totalUnreadCount).toBe(25);
    expect(window.droppedUnreadCount).toBe(5);
    expect(window.bookmarkState).toBe("missing");
    expect(window.messages.map((message) => message.body)).toEqual(
      Array.from({ length: 20 }, (_, idx) => `message ${idx + 6}`),
    );
  });

  it("passes rolling unread delivery metadata into immediate channel delivery", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "gsap");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["gsap", "yui"],
    });
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    for (let i = 1; i <= 23; i += 1) {
      await appendMessage(channelFile, "user", `message ${i}`);
    }

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["gsap"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    });

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).toHaveBeenCalledOnce();
    expect(executeCheck.mock.calls[0][2].map((message) => message.body)).toEqual(
      Array.from({ length: 20 }, (_, idx) => `message ${idx + 4}`),
    );
    expect(executeCheck.mock.calls[0][4]).toMatchObject({
      deliveryWindow: {
        totalUnreadCount: 23,
        droppedUnreadCount: 3,
        bookmarkState: "never",
      },
    });
  });

  it("delivers unread channel messages to members even when their cursor projection is missing", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "gsap");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["gsap", "yui"],
    });
    await appendMessage(path.join(channelsDir, `${channelId}.md`), "user", "@G-SAP hello");

    const executeCheck = vi.fn(async () => ({ replied: false }));
    const onMemorySummarize = vi.fn();
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["gsap"],
      executeCheck,
      onMemorySummarize,
    });

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).toHaveBeenCalledOnce();
    expect(executeCheck.mock.calls[0][0]).toBe("gsap");
    expect(executeCheck.mock.calls[0][1]).toBe(channelId);
  });

  it("prioritizes mentioned members while still delivering context to other members", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["gsap", "yui", "ming"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["gsap", "yui", "ming"],
    });
    await appendMessage(path.join(channelsDir, `${channelId}.md`), "user", "@Yui please check");

    const seen = [];
    const executeCheck = vi.fn(async (agentId, _channelName, _newMessages, _allUpdates, opts) => {
      seen.push({
        agentId,
        mentionedAgents: opts?.mentionedAgents,
        mentionTargeted: opts?.mentionTargeted,
      });
      return { replied: false, passed: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["gsap", "yui", "ming"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    });

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId, { mentionedAgents: ["yui"] });
    } finally {
      await ticker.stop();
    }

    expect(seen).toEqual([
      { agentId: "yui", mentionedAgents: ["yui"], mentionTargeted: true },
      { agentId: "gsap", mentionedAgents: ["yui"], mentionTargeted: false },
      { agentId: "ming", mentionedAgents: ["yui"], mentionTargeted: false },
    ]);
  });

  it("does not re-deliver agent replies to the same members during one immediate delivery", async () => {
    vi.useFakeTimers();
    try {
      tmpDir = mktemp();
      const channelsDir = path.join(tmpDir, "channels");
      const agentsDir = path.join(tmpDir, "agents");
      for (const agentId of ["pm-1", "worker-1"]) {
        const agentDir = path.join(agentsDir, agentId);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
      }

      const { id: channelId } = await createChannel(channelsDir, {
        id: "ch_crew",
        name: "Crew",
        members: ["pm-1", "worker-1"],
        memberRoles: {
          "pm-1": "project_manager",
          "worker-1": "worker",
        },
      });
      const channelFile = path.join(channelsDir, `${channelId}.md`);
      vi.setSystemTime(new Date("2026-06-03T00:00:00Z"));
      await appendMessage(channelFile, "user", "请协作处理任务");

      let second = 1;
      const seen = [];
      const executeCheck = vi.fn(async (agentId, _channelName, newMessages) => {
        seen.push({ agentId, bodies: newMessages.map((message) => message.body) });
        vi.setSystemTime(new Date(`2026-06-03T00:00:${String(second).padStart(2, "0")}Z`));
        second += 1;
        await appendMessage(channelFile, agentId, `${agentId} 已收到`);
        return { replied: true, replyContent: `${agentId} 已收到` };
      });
      const ticker = createChannelTicker({
        channelsDir,
        agentsDir,
        getAgentOrder: () => ["pm-1", "worker-1"],
        executeCheck,
        onMemorySummarize: vi.fn(),
      });

      ticker.start();
      try {
        await ticker.triggerImmediate(channelId);
      } finally {
        await ticker.stop();
      }

      expect(seen.map((entry) => entry.agentId)).toEqual(["pm-1", "worker-1"]);
      expect(executeCheck).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders group delivery by channel role and passes role context into the executor", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["worker-1", "admin-1", "pm-1"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const memberRoles = {
      "worker-1": "worker",
      "admin-1": "admin",
      "pm-1": "project_manager",
    };
    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["worker-1", "admin-1", "pm-1"],
      memberRoles,
    });
    await appendMessage(path.join(channelsDir, `${channelId}.md`), "user", "需要多人协作处理");

    const seen = [];
    const executeCheck = vi.fn(async (agentId, _channelName, _newMessages, _allUpdates, opts) => {
      seen.push({
        agentId,
        role: opts?.channelMemberRole,
        roleMap: opts?.channelMemberRoles,
      });
      return { replied: false, passed: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["worker-1", "admin-1", "pm-1"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    });

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(seen).toEqual([
      { agentId: "pm-1", role: "project_manager", roleMap: memberRoles },
      { agentId: "admin-1", role: "admin", roleMap: memberRoles },
      { agentId: "worker-1", role: "worker", roleMap: memberRoles },
    ]);
  });

  it("honors the phone ticker enable gate before immediate delivery", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "gsap");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# Channels\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["gsap"],
    });
    await appendMessage(path.join(channelsDir, `${channelId}.md`), "user", "hello");

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["gsap"],
      executeCheck,
      onMemorySummarize: vi.fn(),
      isEnabled: () => false,
    });

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).not.toHaveBeenCalled();
  });
});
