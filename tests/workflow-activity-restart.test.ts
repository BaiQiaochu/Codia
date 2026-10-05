import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityHub } from "../lib/activity-hub.ts";
import { WorkflowActivityStore } from "../lib/workflow-activity-store.ts";

// 端到端：跑 workflow（hub.upsert 写穿持久化）→ 模拟重启（新建 store + hub 实例）→
// 右侧卡数据仍在 + 会话载入重发。覆盖 §3.6 收尾验收条件。

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-restart-"));
  file = path.join(dir, "workflow-activity.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SP = "/s/a.jsonl";

describe("workflow 卡重启持久化（端到端）", () => {
  it("完成的 workflow：重启后数据还在、状态保终态、会话载入重发", () => {
    // ── 进程 1：跑一个 workflow（父 + 一个节点），全部跑完 ──
    {
      const store = new WorkflowActivityStore(file);
      const hub = new ActivityHub(null, store);
      // workflow-tool.js 的真实 upsert 序列（父 running → 节点 running → 节点 done → 父 done）
      hub.upsert({ id: "wf-1", kind: "workflow", status: "running", sessionPath: SP, agentId: "hana", summary: "三主题诗", startedAt: 1000 });
      hub.upsert({ id: "wf-1::n0", kind: "workflow_agent", status: "running", sessionPath: SP, parentTaskId: "wf-1", label: "写诗", startedAt: 1100 });
      hub.upsert({ id: "wf-1::n0", status: "done", childSessionPath: "/s/child.jsonl", tokens: 800, finishedAt: 1500 });
      hub.upsert({ id: "wf-1", status: "done", finishedAt: 1600 });
    }

    // ── 进程 2：重启（全新 store + hub 实例，只共享磁盘文件）──
    const store2 = new WorkflowActivityStore(file);
    const bus = { emit: vi.fn() };
    const hub2 = new ActivityHub(bus, store2);

    // 右侧卡数据还在（按 session 取）
    const list = hub2.listBySession(SP);
    expect(list.map((e) => e.id).sort()).toEqual(["wf-1", "wf-1::n0"]);
    const wf = hub2.get("wf-1");
    expect(wf.status).toBe("done");          // 终态保留，不回退 running
    expect(wf.summary).toBe("三主题诗");
    const node = hub2.get("wf-1::n0");
    expect(node.status).toBe("done");
    expect(node.tokens).toBe(800);
    expect(node.childSessionPath).toBe("/s/child.jsonl");

    // 会话载入重发：前端 slice 据此重新填充
    hub2.rebroadcastSession(SP);
    const emittedIds = bus.emit.mock.calls
      .filter((c) => c[0]?.type === "agent_activity")
      .map((c) => c[0].entry.id)
      .sort();
    expect(emittedIds).toEqual(["wf-1", "wf-1::n0"]);
  });

  it("跑到一半被重启的 workflow：遗留 running 判孤儿 → 重启后显示 failed（不永久转圈）", () => {
    // 进程 1：派出后只跑了一半就被杀（父 + 节点都停在 running）
    {
      const store = new WorkflowActivityStore(file);
      const hub = new ActivityHub(null, store);
      hub.upsert({ id: "wf-2", kind: "workflow", status: "running", sessionPath: SP, summary: "中断的", startedAt: 2000 });
      hub.upsert({ id: "wf-2::n0", kind: "workflow_agent", status: "running", sessionPath: SP, parentTaskId: "wf-2", startedAt: 2100 });
    }
    // 进程 2：重启回灌，孤儿 running → failed
    const hub2 = new ActivityHub(null, new WorkflowActivityStore(file));
    expect(hub2.get("wf-2").status).toBe("failed");
    expect(hub2.get("wf-2").finishedAt).toBe(2000);   // 用 startedAt 兜底
    expect(hub2.get("wf-2::n0").status).toBe("failed");
  });

  it("会话退场清理后：重启不再回灌该会话（持久化也清了）", () => {
    {
      const store = new WorkflowActivityStore(file);
      const hub = new ActivityHub(null, store);
      hub.upsert({ id: "wf-3", kind: "workflow", status: "done", sessionPath: SP, startedAt: 1, finishedAt: 2 });
      hub.upsert({ id: "wf-3b", kind: "workflow", status: "done", sessionPath: "/s/keep.jsonl", startedAt: 1, finishedAt: 2 });
      hub.clearBySession(SP); // 会话删除 → 内存 + 持久化一并清
    }
    const hub2 = new ActivityHub(null, new WorkflowActivityStore(file));
    expect(hub2.listBySession(SP)).toEqual([]);
    expect(hub2.get("wf-3b")).toBeTruthy(); // 其它会话不受影响
  });
});
