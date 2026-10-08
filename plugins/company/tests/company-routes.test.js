import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerCompanyRoutes from "../routes/company.js";

let tempDir;

function makeCtx(overrides = {}) {
  const busRequests = [];
  const bridgeSends = [];
  const channelPosts = [];
  const emit = vi.fn();
  const bridgeEnabled = overrides.bridgeEnabled !== false;
  return {
    pluginId: "company",
    dataDir: tempDir,
    bus: {
      request: vi.fn(async (type, payload = {}) => {
        busRequests.push({ type, payload });
        if (type === "bridge:send-text") {
          bridgeSends.push(payload);
          if (overrides.bridgeSendError) throw new Error(overrides.bridgeSendError);
          return { ok: true, deliveryId: "bridge-delivery-1" };
        }
        if (type === "channel:members") {
          return overrides.channelMembers || null;
        }
        if (type === "channel:post-message") {
          channelPosts.push(payload);
          return { ok: true, timestamp: "2026-05-31T00:00:00.000Z" };
        }
        if (type === "agent:list") {
          return {
            agents: [
              { id: "pm", name: "项目经理" },
              { id: "writer", name: "策划/编剧" },
              { id: "visual", name: "视觉设计" },
              { id: "video", name: "视频制作" },
              { id: "ops", name: "运营/质检" },
            ],
          };
        }
        throw new Error(`unexpected bus request: ${type}`);
      }),
      hasHandler: vi.fn((type) => bridgeEnabled && type === "bridge:send-text"),
      emit,
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    busRequests,
    bridgeSends,
    channelPosts,
    emit,
    ...overrides,
  };
}

function makeApp(ctx = makeCtx()) {
  const app = new Hono();
  registerCompanyRoutes(app, ctx);
  return { app, ctx };
}

async function json(app, pathName, init) {
  const res = await app.request(pathName, init);
  return { res, body: await res.json() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-company-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("company plugin routes", () => {
  it("creates a ready-made one-person company with five trained employees", async () => {
    const { app } = makeApp();

    const created = await json(app, "/companies/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "成品一人公司" }),
    });

    expect(created.res.status).toBe(200);
    expect(created.body.company).toMatchObject({ name: "成品一人公司" });
    expect(created.body.company.employees).toHaveLength(5);
    expect(created.body.company.employees.map((item) => item.role)).toEqual([
      "project_manager",
      "writer",
      "visual_designer",
      "video_producer",
      "ops_qc",
    ]);
    expect(created.body.company.employees.find((item) => item.role === "project_manager")).toMatchObject({
      title: "项目经理",
      agentId: "pm",
      status: "ready",
    });

    const status = await json(app, `/companies/${created.body.company.id}/status`);
    expect(status.body.summary).toMatchObject({ employeeCount: 5, taskCount: 0, channelCount: 0 });
  });

  it("binds social groups as channel truth and turns boss commands into PM dispatch tasks", async () => {
    const { app, ctx } = makeApp();
    const company = await json(app, "/companies/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const companyId = company.body.company.id;

    const bound = await json(app, "/channels/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId,
        platform: "telegram",
        externalGroupId: "tg-product-crew",
        externalTitle: "老板项目群",
        mirrorToExternal: true,
      }),
    });

    expect(bound.res.status).toBe(200);
    expect(bound.body.channel).toMatchObject({
      platform: "telegram",
      externalGroupId: "tg-product-crew",
      externalTitle: "老板项目群",
      status: "connected",
    });

    const message = await json(app, `/channels/${bound.body.channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        senderName: "老板",
        senderId: "boss",
        isBoss: true,
        text: "@项目经理 做一条产品宣传片，需要脚本、视觉关键帧、图生视频和发布文案。",
      }),
    });

    expect(message.res.status).toBe(200);
    expect(message.body.createdTasks.map((task) => task.assigneeRole)).toEqual([
      "project_manager",
      "writer",
      "visual_designer",
      "video_producer",
      "ops_qc",
    ]);
    expect(message.body.message.truthId).toMatch(/^msg_/);

    const status = await json(app, `/companies/${companyId}/status`);
    expect(status.body.summary.taskCount).toBe(5);
    expect(status.body.channels[0].truth.messages[0]).toMatchObject({
      senderName: "老板",
      text: expect.stringContaining("产品宣传片"),
    });
    expect(ctx.emit).toHaveBeenCalledTimes(5);
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "company_task_assigned",
      companyId,
      channelId: bound.body.channel.id,
      assigneeRole: "project_manager",
    }), null);
  });

  it("clears company task trees for selected channel ids", async () => {
    const { app } = makeApp();
    const company = await json(app, "/companies/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const companyId = company.body.company.id;

    await json(app, "/tasks/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, channelId: "channel-a", command: "build page" }),
    });
    await json(app, "/tasks/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, channelId: "channel-b", command: "write copy" }),
    });

    const cleared = await json(app, "/tasks/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, channelIds: ["channel-a"] }),
    });

    expect(cleared.res.status).toBe(200);
    expect(cleared.body).toMatchObject({ ok: true, removedCount: 1 });

    const status = await json(app, `/companies/${companyId}/status`);
    expect(status.body.tasks).toHaveLength(1);
    expect(status.body.tasks.every((task) => task.channelId === "channel-b")).toBe(true);
  });

  it("assigns editable workflow canvas nodes to channel agents with edge dependencies", async () => {
    const { app, ctx } = makeApp(makeCtx({
      channelMembers: {
        members: ["worker-a", "worker-b", "director-a"],
        memberRoles: { "worker-a": "project_manager", "worker-b": "worker", "director-a": "admin" },
        agents: [
          { id: "worker-a", name: "管理员A" },
          { id: "worker-b", name: "工人B" },
          { id: "director-a", name: "总监A" },
        ],
      },
    }));
    const company = await json(app, "/companies/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const companyId = company.body.company.id;

    const assigned = await json(app, "/tasks/assign-from-workflow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId,
        channelId: "crew",
        workflow: {
          id: "wf-crew",
          title: "频道工作流",
          supervision: {
            mode: "director_group",
            supervisorAgentIds: ["director-a"],
          },
          nodes: [
            { id: "node-plan", title: "规划任务", prompt: "拆分实施步骤", assigneeAgentId: "worker-a", assigneeRole: "project_manager" },
            { id: "node-build", title: "执行任务", prompt: "按规划修改代码并回报", assigneeAgentId: "worker-b", assigneeRole: "worker" },
          ],
          edges: [{ id: "edge-plan-build", from: "node-plan", to: "node-build" }],
        },
      }),
    });

    expect(assigned.res.status).toBe(202);
    expect(assigned.body.tasks).toHaveLength(2);
    expect(assigned.body.tasks[0]).toMatchObject({
      title: expect.stringContaining("规划任务"),
      assigneeAgentId: "worker-a",
      taskKind: "workflow_node",
      dependsOn: [],
    });
    expect(assigned.body.tasks[1]).toMatchObject({
      title: expect.stringContaining("执行任务"),
      assigneeAgentId: "worker-b",
      taskKind: "workflow_node",
      dependsOn: [assigned.body.tasks[0].id],
    });
    expect(ctx.channelPosts).toHaveLength(1);
    expect(ctx.channelPosts[0]).toMatchObject({
      channelId: "crew",
      mentionedAgents: ["worker-a", "worker-b", "director-a"],
      triggerDelivery: true,
    });
    expect(ctx.channelPosts[0].body).toContain("@director-a");
    expect(assigned.body.tasks[0].source.supervision).toMatchObject({
      mode: "director_group",
      supervisorAgentIds: expect.arrayContaining(["worker-a", "director-a"]),
    });
  });

  it("mirrors internal employee replies to social groups and preserves truth when the bridge is offline", async () => {
    const online = makeCtx();
    const { app } = makeApp(online);
    const company = await json(app, "/companies/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const bound = await json(app, "/channels/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId: company.body.company.id,
        platform: "tg",
        externalGroupId: "tg-production",
        externalTitle: "产线群",
        mirrorToExternal: true,
      }),
    });

    const reply = await json(app, `/channels/${bound.body.channel.id}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        senderId: "video",
        senderName: "视频制作",
        text: "第一版镜头已经提交，请质检确认。",
      }),
    });

    expect(reply.res.status).toBe(200);
    expect(reply.body.message.delivery).toMatchObject({ status: "sent", platform: "telegram", externalGroupId: "tg-production" });
    expect(online.bridgeSends).toEqual([
      expect.objectContaining({
        platform: "telegram",
        chatId: "tg-production",
        text: expect.stringContaining("第一版镜头已经提交"),
      }),
    ]);

    const offlineCtx = makeCtx({ bridgeSendError: "platform disconnected" });
    const offlineApp = makeApp(offlineCtx).app;
    const offlineCompany = await json(offlineApp, "/companies/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const offlineBound = await json(offlineApp, "/channels/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId: offlineCompany.body.company.id,
        platform: "feishu",
        externalGroupId: "fs-production",
        externalTitle: "离线产线群",
        mirrorToExternal: true,
      }),
    });

    const queued = await json(offlineApp, `/channels/${offlineBound.body.channel.id}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        senderId: "writer",
        senderName: "策划/编剧",
        text: "脚本已完成，等待视觉设计接收。",
      }),
    });

    expect(queued.res.status).toBe(200);
    expect(queued.body.message.delivery).toMatchObject({
      status: "queued",
      error: "platform disconnected",
      platform: "feishu",
    });
    const disconnected = await json(offlineApp, `/channels/${offlineBound.body.channel.id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disconnected", reason: "adapter lost" }),
    });
    expect(disconnected.body.channel).toMatchObject({
      status: "disconnected",
      statusReason: "adapter lost",
    });
    const restored = await json(offlineApp, `/companies/${offlineCompany.body.company.id}/status`);
    const restoredChannel = restored.body.channels.find((channel) => channel.id === offlineBound.body.channel.id);
    expect(restoredChannel.status).toBe("disconnected");
    expect(restoredChannel.truth.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        senderName: "策划/编剧",
        text: "脚本已完成，等待视觉设计接收。",
        delivery: expect.objectContaining({ status: "queued" }),
      }),
    ]));
  });
});
