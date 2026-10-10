import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute as assignCompanyTask } from "../tools/assign.js";
import { execute as reportCompanyTask } from "../tools/report.js";
import { execute as getCompanyStatus } from "../tools/status.js";

let tempDir;

function makeCtx(overrides = {}) {
  return {
    pluginId: "company",
    dataDir: tempDir,
    bus: {
      request: vi.fn(async (type) => {
        if (type === "agent:list") return { agents: [] };
        throw new Error(`unexpected bus request: ${type}`);
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-company-tools-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("company agent tools", () => {
  it("company_assign creates PM task cards with assignees and acceptance criteria", async () => {
    const result = await assignCompanyTask({
      command: "给客户做 30 秒宣传片，先写脚本，再做视觉关键帧和图生视频。",
      dueAt: "2026-05-30",
      acceptanceCriteria: ["脚本可拍摄", "关键帧可复用", "视频可交付"],
    }, makeCtx());

    expect(result.details.tasks.map((task) => task.assigneeRole)).toEqual([
      "project_manager",
      "writer",
      "visual_designer",
      "video_producer",
    ]);
    expect(result.details.tasks[0]).toMatchObject({
      status: "assigned",
      dueAt: "2026-05-30",
      acceptanceCriteria: ["脚本可拍摄", "关键帧可复用", "视频可交付"],
    });
    expect(result.content[0].text).toContain("已创建 4 个公司任务");
  });

  it("company_status summarizes employees, channels, and task states", async () => {
    const ctx = makeCtx();
    await assignCompanyTask({
      command: "准备发布文案并做质检。",
    }, ctx);

    const result = await getCompanyStatus({}, ctx);

    expect(result.content[0].text).toContain("成品一人公司");
    expect(result.content[0].text).toContain("员工：5");
    expect(result.content[0].text).toContain("任务：2");
    expect(result.details.summary).toMatchObject({ employeeCount: 5, taskCount: 2 });
  });

  it("company_report updates the latest channel task for the calling agent", async () => {
    const ctx = makeCtx({
      bus: {
        request: vi.fn(async (type) => {
          if (type === "agent:list") {
            return {
              agents: [
                { id: "project_manager", name: "project_manager" },
                { id: "writer", name: "writer" },
              ],
            };
          }
          throw new Error(`unexpected bus request: ${type}`);
        }),
      },
    });

    const assigned = await assignCompanyTask({
      channelId: "crew",
      command: "Build a delivery plan",
      assigneeRole: "writer",
    }, ctx);

    expect(assigned.details.tasks.some((task) => task.assigneeAgentId === "writer")).toBe(true);

    const result = await reportCompanyTask({
      channelId: "crew",
      status: "completed",
      report: "Delivery plan finished.",
      artifacts: [{ path: "plan.md" }],
    }, {
      ...ctx,
      agentId: "writer",
      channelId: "crew",
    });

    expect(result.details.task).toMatchObject({
      assigneeAgentId: "writer",
      channelId: "crew",
      status: "completed",
      report: "Delivery plan finished.",
      artifacts: [{ path: "plan.md" }],
    });
    expect(result.content[0].text).toContain("completed");
  });
});
