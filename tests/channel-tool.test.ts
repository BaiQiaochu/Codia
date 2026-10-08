// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelTool } from "../lib/tools/channel-tool.js";

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channel-tool-"));
  const channelsDir = path.join(root, "channels");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
  return { root, channelsDir, agentsDir };
}

function writeChannel(channelsDir, id, members, meta = {}) {
  const filePath = path.join(channelsDir, `${id}.md`);
  fs.writeFileSync(filePath, [
    "---",
    `id: ${id}`,
    meta.name ? `name: ${meta.name}` : null,
    `members: [${members.join(", ")}]`,
    "---",
    "",
  ].filter(Boolean).join("\n"), "utf-8");
  return filePath;
}

describe("channel tool", () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("does not read or write channels when the global channel switch is disabled", async () => {
    const { root, channelsDir, agentsDir } = makeTempRoot();
    tempRoot = root;
    const onPost = vi.fn();
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "agent-a",
      listAgents: () => [],
      onPost,
      isEnabled: () => false,
    });

    const result = await tool.execute("call-1", {
      action: "create",
      name: "Ops",
      members: ["agent-a"],
    });

    expect(result.details).toEqual({ action: "create", error: "channels disabled" });
    expect(fs.readdirSync(channelsDir)).toEqual([]);
    expect(onPost).not.toHaveBeenCalled();
  });

  it("passes the posted message payload to the channel post callback", async () => {
    const { root, channelsDir, agentsDir } = makeTempRoot();
    tempRoot = root;
    writeChannel(channelsDir, "ch_ops", ["agent-a", "agent-b"]);
    const onPost = vi.fn();
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "agent-a",
      listAgents: () => [],
      onPost,
      isEnabled: () => true,
    });

    const result = await tool.execute("call-1", {
      action: "post",
      channel: "ch_ops",
      content: "Build finished.",
    });

    expect(result.details).toMatchObject({ action: "post", channel: "ch_ops" });
    expect(result.details.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(onPost).toHaveBeenCalledWith("ch_ops", "agent-a", {
      sender: "agent-a",
      timestamp: result.details.timestamp,
      body: "Build finished.",
    });
    expect(fs.readFileSync(path.join(channelsDir, "ch_ops.md"), "utf-8")).toContain("Build finished.");
  });

  it("resolves joined channels by display name", async () => {
    const { root, channelsDir, agentsDir } = makeTempRoot();
    tempRoot = root;
    writeChannel(channelsDir, "ch_ops", ["agent-a", "agent-b"], { name: "Ops Team" });
    const onPost = vi.fn();
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "agent-a",
      listAgents: () => [],
      onPost,
      isEnabled: () => true,
    });

    const result = await tool.execute("call-1", {
      action: "post",
      channel: "Ops Team",
      content: "Ready.",
    });

    expect(result.details).toMatchObject({ action: "post", channel: "ch_ops", name: "Ops Team" });
    expect(onPost).toHaveBeenCalledWith("ch_ops", "agent-a", expect.objectContaining({
      body: "Ready.",
    }));
  });

  it("creates channels through the host channel manager entry", async () => {
    const { root, channelsDir, agentsDir } = makeTempRoot();
    tempRoot = root;
    const createChannelEntry = vi.fn(async (opts) => ({
      id: "ch_created",
      filePath: path.join(channelsDir, "ch_created.md"),
      opts,
    }));
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "agent-a",
      listAgents: () => [],
      onPost: vi.fn(),
      isEnabled: () => true,
      createChannelEntry,
    });

    const result = await tool.execute("call-1", {
      action: "create",
      name: "Ops",
      members: ["agent-b"],
      intro: "Coordinate work.",
    });

    expect(result.details).toMatchObject({
      action: "create",
      channel: "ch_created",
      members: ["agent-a", "agent-b"],
    });
    expect(createChannelEntry).toHaveBeenCalledWith(expect.objectContaining({
      name: "Ops",
      members: ["agent-a", "agent-b"],
      intro: "Coordinate work.",
      addUserBookmark: true,
    }));
  });

  it("includes rich file blocks when agents read channel messages", async () => {
    const { root, channelsDir, agentsDir } = makeTempRoot();
    tempRoot = root;
    writeChannel(channelsDir, "ch_ops", ["agent-a", "agent-b"]);
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "agent-a",
      listAgents: () => [],
      onPost: vi.fn(),
      isEnabled: () => true,
    });

    await tool.execute("call-1", {
      action: "post",
      channel: "ch_ops",
      content: "",
      blocks: [
        { type: "file", filePath: "E:/uploads/demo.png", label: "demo.png", ext: "png", kind: "image" },
      ],
    });

    const result = await tool.execute("call-2", {
      action: "read",
      channel: "ch_ops",
      count: 5,
    });

    expect(result.content[0].text).toContain("[file:image] demo.png");
    expect(result.content[0].text).toContain("E:/uploads/demo.png");
  });
});
