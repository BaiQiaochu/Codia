import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAfterSalesRoute } from "../server/routes/aftersales.js";

describe("aftersales route skeleton", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-aftersales-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("creates and runs a dry-run aftersales task from message", async () => {
    const app = new Hono();
    const engine = { gsapHome: tempRoot };
    app.route("/api", createAfterSalesRoute(engine));

    const createRes = await app.request("/api/aftersales/tasks/from-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "wechat",
        groupName: "客户测试群",
        senderName: "Alice",
        text: "产品：小七\n场景：夏日沙滩拍摄\n风格：清新电商海报\n尺寸：1024x1024\n要求：看主体完整度",
      }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.ok).toBe(true);
    expect(created.task.caseInfo.productName).toBe("小七");
    expect(created.task.status).toBe("parsed");

    const runRes = await app.request(`/api/aftersales/tasks/${created.task.id}/run`, {
      method: "POST",
    });
    expect(runRes.status).toBe(200);
    const ran = await runRes.json();
    expect(ran.ok).toBe(true);
    expect(ran.task.status).toBe("success");
    expect(ran.task.execution.mode).toBe("dry-run");
    expect(ran.task.feedback.replyText).toContain("当前为骨架演示模式");
  });

  it("can switch to live mode config without schema errors", async () => {
    const app = new Hono();
    const engine = { gsapHome: tempRoot };
    app.route("/api", createAfterSalesRoute(engine));

    const res = await app.request("/api/aftersales/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        wechat: { enabled: true, autoRunTask: true },
        designPlatform: {
          mode: "live",
          submitUrl: "https://example.com/api/submit",
          workflowId: "wf_123",
          apiKey: "sk-test",
          polling: { enabled: true, statusUrlTemplate: "https://example.com/api/tasks/{taskId}" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.config.designPlatform.mode).toBe("live");
    expect(body.config.wechat.enabled).toBe(true);
  });
});
