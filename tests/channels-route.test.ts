// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createChannelsRoute } from "../server/routes/channels.js";
import { addBookmarkEntry, getChannelMemberRoles, getChannelMembers } from "../lib/channels/channel-store.js";
import { ChannelManager } from "../core/channel-manager.js";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channels-route-"));
}

describe("channels route role and group-agent features", () => {
  let tempRoot = makeTempRoot();

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = makeTempRoot();
  });

  function createApp() {
    const channelsDir = path.join(tempRoot, "channels");
    const agentsDir = path.join(tempRoot, "agents");
    const userDir = path.join(tempRoot, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    for (const agentId of ["pm-1", "admin-1"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), `agent:\n  name: ${agentId}\n`, "utf-8");
    }

    const engine = {
      channelsDir,
      agentsDir,
      userDir,
      userName: "User",
      listAgents: () => [],
      availableModels: [
        { id: "gpt-5.2", provider: "openai", name: "GPT-5.2" },
      ],
      currentAgentId: "pm-1",
      isChannelsEnabled: vi.fn(() => true),
      createAgent: vi.fn(async ({ name, yuan }) => {
        const id = `agent-${name.toLowerCase().replace(/\s+/g, "-")}`;
        const agentDir = path.join(agentsDir, id);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, "config.yaml"), `agent:\n  name: "${name}"\n  yuan: ${yuan || "gsap"}\n`, "utf-8");
        return { id, name };
      }),
      getAgent: (agentId) => {
        const agentDir = path.join(agentsDir, agentId);
        return fs.existsSync(agentDir) ? { id: agentId, agentDir } : null;
      },
      deleteAgent: vi.fn(async (id) => {
        fs.rmSync(path.join(agentsDir, id), { recursive: true, force: true });
      }),
      getChannelMemberRoles: (channelId) => getChannelMemberRoles(path.join(channelsDir, `${channelId}.md`)),
      createChannelEntry: (opts) => {
        const manager = new ChannelManager({ channelsDir, agentsDir, userDir, getHub: () => null });
        return manager.createChannelEntry(opts);
      },
      updateChannelMemberRole: (channelId, memberId, role) => {
        const manager = new ChannelManager({ channelsDir, agentsDir, userDir, getHub: () => null });
        return manager.updateChannelMemberRole(channelId, memberId, role);
      },
      addAgentToChannel: (channelId, agentId, role) => {
        const manager = new ChannelManager({ channelsDir, agentsDir, userDir, getHub: () => null });
        return manager.addAgentToChannel(channelId, agentId, role);
      },
      deleteChannelByName: vi.fn(),
    };

    const hub = {
      triggerChannelTriage: vi.fn(async () => {}),
      toggleChannels: vi.fn(async () => {}),
      channelRouter: { syncAvailability: vi.fn(async () => {}) },
      activityHub: { upsert: vi.fn() },
    };

    const app = new Hono();
    app.route("/api", createChannelsRoute(engine, hub));

    return { app, engine, hub, channelsDir, agentsDir };
  }

  it("creates a channel with roles and returns them on detail fetch", async () => {
    const { app } = createApp();

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Build Team",
        members: ["pm-1", "admin-1"],
        memberRoles: { "pm-1": "project_manager", "admin-1": "admin" },
        intro: "Ship the release",
      }),
    });

    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.memberRoles).toEqual({
      "pm-1": "project_manager",
      "admin-1": "admin",
    });

    const detailRes = await app.request(`/api/channels/${created.id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.memberRoles).toEqual({
      "pm-1": "project_manager",
      "admin-1": "admin",
    });
    expect(detail.roleCounts).toEqual({
      project_manager: 1,
      admin: 1,
      worker: 0,
    });
  });

  it("uses the entered channel name as the stable channel id when it is filesystem-safe", async () => {
    const { app } = createApp();

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "design-team",
        members: ["pm-1", "admin-1"],
      }),
    });

    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.id).toBe("ch_design-team");
    expect(created.name).toBe("design-team");

    const detailRes = await app.request("/api/channels/ch_design-team");
    expect(detailRes.status).toBe(200);
    expect(await detailRes.json()).toMatchObject({
      id: "ch_design-team",
      name: "design-team",
    });
  });

  it("updates a member role and can create a new agent directly inside the group", async () => {
    const { app, engine, agentsDir, hub } = createApp();

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops Team",
        members: ["pm-1", "admin-1"],
        memberRoles: { "pm-1": "project_manager", "admin-1": "admin" },
      }),
    });
    const created = await createRes.json();

    const roleRes = await app.request(`/api/channels/${created.id}/roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "admin-1", role: "worker" }),
    });
    expect(roleRes.status).toBe(200);
    const roleBody = await roleRes.json();
    expect(roleBody.memberRoles["admin-1"]).toBe("worker");

    const addAgentRes = await app.request(`/api/channels/${created.id}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Build Worker",
        yuan: "hermes",
        role: "worker",
        homeFolder: path.join(tempRoot, "workspace-target"),
      }),
    });
    expect(addAgentRes.status).toBe(200);
    const addAgentBody = await addAgentRes.json();
    expect(engine.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: "Build Worker",
      yuan: "hermes",
      homeFolder: path.join(tempRoot, "workspace-target"),
    }));
    expect(addAgentBody.agent.id).toBe("agent-build-worker");
    expect(addAgentBody.memberRoles["agent-build-worker"]).toBe("worker");
    expect(fs.existsSync(path.join(agentsDir, "agent-build-worker", "channels.md"))).toBe(true);
    expect(hub.channelRouter.syncAvailability).toHaveBeenCalled();
  });

  it("adds and removes channel members while preserving role metadata", async () => {
    const { app, agentsDir, channelsDir, hub } = createApp();
    const memberDir = path.join(agentsDir, "agent-extra");
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, "config.yaml"), "agent:\n  name: Extra\n", "utf-8");

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Crew",
        members: ["pm-1", "admin-1"],
        memberRoles: { "pm-1": "project_manager", "admin-1": "admin" },
      }),
    });
    const created = await createRes.json();

    const addRes = await app.request(`/api/channels/${created.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "agent-extra" }),
    });
    expect(addRes.status).toBe(200);
    expect(await addRes.json()).toMatchObject({
      ok: true,
      members: ["pm-1", "admin-1", "agent-extra"],
      memberRoles: {
        "pm-1": "project_manager",
        "admin-1": "admin",
        "agent-extra": "worker",
      },
    });
    expect(fs.readFileSync(path.join(memberDir, "channels.md"), "utf-8")).toContain(created.id);
    expect(hub.channelRouter.syncAvailability).toHaveBeenCalled();

    const removeRes = await app.request(`/api/channels/${created.id}/members/agent-extra`, {
      method: "DELETE",
    });
    expect(removeRes.status).toBe(200);
    expect(await removeRes.json()).toMatchObject({
      ok: true,
      members: ["pm-1", "admin-1"],
      memberRoles: {
        "pm-1": "project_manager",
        "admin-1": "admin",
      },
    });
    expect(getChannelMembers(path.join(channelsDir, `${created.id}.md`))).toEqual(["pm-1", "admin-1"]);
    const memberChannelsPath = path.join(memberDir, "channels.md");
    if (fs.existsSync(memberChannelsPath)) {
      expect(fs.readFileSync(memberChannelsPath, "utf-8")).not.toContain(created.id);
    }
    expect(hub.channelRouter.syncAvailability).toHaveBeenCalledTimes(2);
  });

  it("allows removing all channel members and adding one back to an existing channel", async () => {
    const { app, agentsDir } = createApp();
    const extraDir = path.join(agentsDir, "agent-extra");
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, "config.yaml"), "agent:\n  name: Extra\n", "utf-8");

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Minimum", members: ["pm-1", "admin-1"] }),
    });
    const created = await createRes.json();

    const removeRes = await app.request(`/api/channels/${created.id}/members/admin-1`, {
      method: "DELETE",
    });

    expect(removeRes.status).toBe(200);
    expect(await removeRes.json()).toMatchObject({
      ok: true,
      members: ["pm-1"],
      memberRoles: { "pm-1": "project_manager" },
    });

    const lastRemoveRes = await app.request(`/api/channels/${created.id}/members/pm-1`, {
      method: "DELETE",
    });
    expect(lastRemoveRes.status).toBe(200);
    expect(await lastRemoveRes.json()).toMatchObject({
      ok: true,
      members: [],
      memberRoles: {},
      roleCounts: { project_manager: 0, admin: 0, worker: 0 },
    });

    const addBackRes = await app.request(`/api/channels/${created.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "agent-extra" }),
    });
    expect(addBackRes.status).toBe(200);
    expect(await addBackRes.json()).toMatchObject({
      ok: true,
      members: ["agent-extra"],
      memberRoles: { "agent-extra": "project_manager" },
    });
  });

  it("rejects channel messages while channels are disabled", async () => {
    const { app, engine, hub } = createApp();
    engine.isChannelsEnabled.mockReturnValue(false);

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disabled", members: ["pm-1", "admin-1"] }),
    });
    const created = await createRes.json();

    const sendRes = await app.request(`/api/channels/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });

    expect(sendRes.status).toBe(503);
    expect((await sendRes.json()).error).toMatch(/disabled/i);
    expect(hub.triggerChannelTriage).not.toHaveBeenCalled();
  });

  it("bridges channel workflow trigger metadata into ActivityHub without replacing channel delivery", async () => {
    const { app, hub } = createApp();
    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Workflow",
        members: ["pm-1", "admin-1"],
      }),
    });
    const created = await createRes.json();

    const workflowPlan = {
      id: "wf-channel-plan",
      title: "Channel launch workflow",
      nodes: [
        { id: "node-1", title: "Plan", agentId: "pm-1" },
        { id: "node-2", title: "Review", agentId: "admin-1" },
      ],
    };
    const triggerRes = await app.request(`/api/channels/${created.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "workflow_window",
        workflowPlan,
        mentionedAgents: ["pm-1", "admin-1"],
      }),
    });

    expect(triggerRes.status).toBe(200);
    expect(await triggerRes.json()).toMatchObject({ ok: true, workflowActivity: expect.objectContaining({ taskId: expect.any(String) }) });
    expect(hub.triggerChannelTriage).toHaveBeenCalledWith(created.id, {
      mentionedAgents: ["pm-1", "admin-1"],
      source: "workflow_window",
      force: true,
    });
    expect(hub.activityHub.upsert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workflow",
      sessionPath: `channel:${created.id}`,
      summary: "Channel launch workflow",
    }));
    expect(hub.activityHub.upsert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workflow_agent",
      sessionPath: `channel:${created.id}`,
      parentTaskId: expect.any(String),
      agentId: "pm-1",
      label: "Plan",
    }));
    expect(hub.activityHub.upsert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workflow_agent",
      sessionPath: `channel:${created.id}`,
      parentTaskId: expect.any(String),
      agentId: "admin-1",
      label: "Review",
    }));
  });

  it("accepts attachment-only channel messages as rich blocks", async () => {
    const { app, channelsDir } = createApp();
    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Media", members: ["pm-1", "admin-1"] }),
    });
    const created = await createRes.json();

    const blocks = [
      { type: "file", filePath: "E:/uploads/demo.mp4", label: "demo.mp4", ext: "mp4", kind: "video" },
    ];
    const sendRes = await app.request(`/api/channels/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "", blocks }),
    });

    expect(sendRes.status).toBe(200);
    expect(await sendRes.json()).toMatchObject({ ok: true });

    const detailRes = await app.request(`/api/channels/${created.id}`);
    const detail = await detailRes.json();
    expect(detail.messages.at(-1)).toMatchObject({
      sender: "User",
      body: "",
      blocks,
    });
    expect(fs.readFileSync(path.join(channelsDir, `${created.id}.md`), "utf-8"))
      .toContain("gsap-channel-message-meta");
  });

  it("resolves completed media generation placeholders when reading channel messages", async () => {
    const { app, engine } = createApp();
    engine.deferredResults = {
      query: vi.fn((taskId) => taskId === "image-task-1"
        ? {
            status: "resolved",
            meta: { type: "image-generation" },
            result: {
              sessionFiles: [{
                id: "sf-image-1",
                filePath: "E:/generated/channel-image.png",
                label: "channel-image.png",
                ext: "png",
                mime: "image/png",
                kind: "image",
              }],
            },
          }
        : null),
    };
    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Image Result", members: ["pm-1", "admin-1"] }),
    });
    const created = await createRes.json();

    const blocks = [
      { type: "media_generation", taskId: "image-task-1", kind: "image", status: "pending", sessionPath: "E:/sessions/phone.jsonl" },
    ];
    const sendRes = await app.request(`/api/channels/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "生成中", blocks }),
    });

    expect(sendRes.status).toBe(200);
    const detailRes = await app.request(`/api/channels/${created.id}`);
    const detail = await detailRes.json();
    expect(engine.deferredResults.query).toHaveBeenCalledWith("image-task-1");
    expect(detail.messages.at(-1)?.blocks).toEqual([{
      type: "file",
      replacesTaskId: "image-task-1",
      fileId: "sf-image-1",
      filePath: "E:/generated/channel-image.png",
      label: "channel-image.png",
      ext: "png",
      mime: "image/png",
      kind: "image",
      sessionPath: "E:/sessions/phone.jsonl",
    }]);
  });

  it("saves and reads channel phone settings without losing role metadata", async () => {
    const { app, channelsDir } = createApp();

    const createRes = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Phone Settings",
        members: ["pm-1", "admin-1"],
        memberRoles: { "pm-1": "project_manager", "admin-1": "admin" },
      }),
    });
    const created = await createRes.json();

    const saveRes = await app.request(`/api/conversations/${created.id}/agent-phone-settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "write",
        replyMinChars: 20,
        replyMaxChars: 120,
        proactiveEnabled: false,
        reminderIntervalMinutes: 45,
        guardLimit: 30,
        modelOverrideEnabled: true,
        modelOverrideModel: { id: "gpt-5.2", provider: "openai" },
      }),
    });

    expect(saveRes.status).toBe(200);
    expect(await saveRes.json()).toMatchObject({
      ok: true,
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 120,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 30,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "gpt-5.2", provider: "openai" },
    });

    const readRes = await app.request(`/api/conversations/${created.id}/agent-phone-settings`);
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 120,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 30,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "gpt-5.2", provider: "openai" },
    });

    expect(getChannelMemberRoles(path.join(channelsDir, `${created.id}.md`))).toEqual({
      "pm-1": "project_manager",
      "admin-1": "admin",
    });
  });
});
