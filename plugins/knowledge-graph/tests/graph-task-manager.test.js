import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../lib/graph-store.js";
import { GraphTaskManager } from "../lib/graph-task-manager.js";

let tempDirs = [];
let stores = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-kg-task-"));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(check, timeout = 1500) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return lastValue;
}

afterEach(() => {
  for (const store of stores) {
    store.destroy();
  }
  stores = [];

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("GraphTaskManager", () => {
  it("runs build tasks asynchronously and updates task state until completion", async () => {
    const store = new GraphStore(makeTempDir());
    stores.push(store);
    const taskManager = new GraphTaskManager(store);

    const submission = taskManager.submitBuildTask({
      title: "Async graph",
      text: "Alpha relates to Beta.",
      rebuild: true,
      sourceId: "task-source-1",
    });

    expect(submission.accepted).toBe(true);
    expect(submission.task).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        type: "knowledge_graph_build",
      }),
    );
    expect(["pending", "running"]).toContain(submission.task.status);
    expect(taskManager.getTaskState()).toEqual(
      expect.objectContaining({
        is_building: true,
        current_task_id: submission.task.id,
        current_task_status: expect.stringMatching(/pending|running/),
        queued_task_count: 0,
        queued_task_ids: [],
        active_task_count: 1,
      }),
    );

    const completed = await waitFor(() => {
      const task = taskManager.getTask(submission.task.id);
      if (!task) return null;
      return task.status === "completed" ? task : null;
    });

    expect(completed).toEqual(
      expect.objectContaining({
        id: submission.task.id,
        status: "completed",
        progress: 100,
        result: expect.objectContaining({
          stats: expect.objectContaining({
            node_count: expect.any(Number),
            edge_count: expect.any(Number),
            source_count: 1,
          }),
        }),
      }),
    );
    expect(store.getData().nodes.length).toBeGreaterThanOrEqual(2);
    expect(taskManager.getTaskState()).toEqual({
      is_building: false,
      building_progress: 0,
      building_message: null,
      current_task_id: null,
      current_task_status: null,
      queued_task_count: 0,
      queued_task_ids: [],
      active_task_count: 0,
    });
  });

  it("queues a second build task while a previous task is still active", async () => {
    const store = new GraphStore(makeTempDir());
    stores.push(store);
    const taskManager = new GraphTaskManager(store);

    const first = taskManager.submitBuildTask({
      title: "First graph",
      text: "Alpha relates to Beta.",
      rebuild: true,
      sourceId: "task-source-1",
    });
    const second = taskManager.submitBuildTask({
      title: "Second graph",
      text: "Gamma leads to Delta.",
      rebuild: true,
      sourceId: "task-source-2",
    });

    expect(first.accepted).toBe(true);
    expect(first.queued).toBe(false);
    expect(second).toEqual(
      expect.objectContaining({
        accepted: true,
        queued: true,
        reason: "queued",
        task: expect.objectContaining({
          id: expect.any(String),
          status: "queued",
          queue_position: 1,
        }),
      }),
    );
    expect(second.task.id).not.toBe(first.task.id);
    expect(taskManager.getTaskState()).toEqual(
      expect.objectContaining({
        is_building: true,
        current_task_id: first.task.id,
        current_task_status: expect.stringMatching(/pending|running/),
        queued_task_count: 1,
        queued_task_ids: [second.task.id],
        active_task_count: 2,
      }),
    );

    const firstCompleted = await waitFor(() => {
      const task = taskManager.getTask(first.task.id);
      if (!task) return null;
      return task.status === "completed" ? task : null;
    }, 2000);

    const secondCompleted = await waitFor(() => {
      const task = taskManager.getTask(second.task.id);
      if (!task) return null;
      return task.status === "completed" ? task : null;
    }, 2000);

    expect(firstCompleted?.status).toBe("completed");
    expect(secondCompleted?.status).toBe("completed");
    expect(taskManager.listTasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.task.id, status: "completed" }),
        expect.objectContaining({ id: second.task.id, status: "completed" }),
      ]),
    );
  });

  it("replaces queued tasks from the same session with the newest request", async () => {
    const store = new GraphStore(makeTempDir());
    stores.push(store);
    const taskManager = new GraphTaskManager(store);

    const first = taskManager.submitBuildTask({
      title: "Session graph 1",
      text: "Alpha relates to Beta.",
      rebuild: true,
      parentSessionPath: "E:/sessions/demo.jsonl",
    });
    const second = taskManager.submitBuildTask({
      title: "Session graph 2",
      text: "Gamma leads to Delta.",
      rebuild: true,
      parentSessionPath: "E:/sessions/demo.jsonl",
    });
    const third = taskManager.submitBuildTask({
      title: "Session graph 3",
      text: "Epsilon connects Zeta.",
      rebuild: true,
      parentSessionPath: "E:/sessions/demo.jsonl",
    });

    expect(first.accepted).toBe(true);
    expect(second.queued).toBe(true);
    expect(third).toEqual(
      expect.objectContaining({
        accepted: true,
        queued: true,
        reason: "queued_replaced",
        replacedTaskIds: [second.task.id],
        task: expect.objectContaining({
          id: expect.any(String),
          status: "queued",
          queue_position: 1,
        }),
      }),
    );

    const replacedTask = taskManager.getTask(second.task.id);
    expect(replacedTask).toEqual(
      expect.objectContaining({
        id: second.task.id,
        status: "cancelled",
        message: "同一会话发起了新的知识图谱构建请求，当前排队任务已被替换",
      }),
    );
    expect(taskManager.getTaskState()).toEqual(
      expect.objectContaining({
        is_building: true,
        current_task_id: first.task.id,
        queued_task_count: 1,
        queued_task_ids: [third.task.id],
        active_task_count: 2,
      }),
    );

    const firstCompleted = await waitFor(() => {
      const task = taskManager.getTask(first.task.id);
      return task?.status === "completed" ? task : null;
    }, 2000);
    const thirdCompleted = await waitFor(() => {
      const task = taskManager.getTask(third.task.id);
      return task?.status === "completed" ? task : null;
    }, 2000);

    expect(firstCompleted?.status).toBe("completed");
    expect(thirdCompleted?.status).toBe("completed");
  });

  it("cancels an active build task and clears active task state", async () => {
    const store = new GraphStore(makeTempDir());
    stores.push(store);
    const taskManager = new GraphTaskManager(store);

    const submission = taskManager.submitBuildTask({
      title: "Cancelable graph",
      rebuild: true,
      documents: [
        { id: "doc-1", title: "Doc 1", text: "Alpha relates to Beta. Beta leads to Gamma." },
        { id: "doc-2", title: "Doc 2", text: "Gamma depends on Delta. Delta supports Epsilon." },
        { id: "doc-3", title: "Doc 3", text: "Epsilon connects Zeta. Zeta references Eta." },
      ],
    });

    expect(submission.accepted).toBe(true);

    const active = await waitFor(() => {
      const task = taskManager.getTask(submission.task.id);
      if (!task) return null;
      return ["pending", "running", "cancelling"].includes(task.status) ? task : null;
    }, 2000);

    expect(active).toBeTruthy();

    const cancelResult = taskManager.cancelTask(submission.task.id);
    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.task).toEqual(
      expect.objectContaining({
        id: submission.task.id,
        status: expect.stringMatching(/cancelling|cancelled/),
      }),
    );

    const cancelled = await waitFor(() => {
      const task = taskManager.getTask(submission.task.id);
      if (!task) return null;
      return task.status === "cancelled" ? task : null;
    }, 2000);

    expect(cancelled).toEqual(
      expect.objectContaining({
        id: submission.task.id,
        status: "cancelled",
        result: null,
        error: null,
      }),
    );
    expect(taskManager.getTaskState()).toEqual({
      is_building: false,
      building_progress: 0,
      building_message: null,
      current_task_id: null,
      current_task_status: null,
      queued_task_count: 0,
      queued_task_ids: [],
      active_task_count: 0,
    });
  });

  it("cancels the current task and queued tasks in one call", async () => {
    const store = new GraphStore(makeTempDir());
    stores.push(store);
    const taskManager = new GraphTaskManager(store);

    const first = taskManager.submitBuildTask({
      title: "Bulk cancel graph 1",
      rebuild: true,
      documents: [
        { id: "doc-1", title: "Doc 1", text: "Alpha relates to Beta. Beta leads to Gamma." },
        { id: "doc-2", title: "Doc 2", text: "Gamma depends on Delta. Delta supports Epsilon." },
        { id: "doc-3", title: "Doc 3", text: "Epsilon connects Zeta. Zeta references Eta." },
      ],
      parentSessionPath: "E:/sessions/cancel.jsonl",
    });
    const second = taskManager.submitBuildTask({
      title: "Bulk cancel graph 2",
      text: "Theta references Iota.",
      rebuild: true,
      parentSessionPath: "E:/sessions/other.jsonl",
    });

    const active = await waitFor(() => {
      const task = taskManager.getTask(first.task.id);
      if (!task) return null;
      return ["pending", "running", "cancelling"].includes(task.status) ? task : null;
    }, 2000);

    expect(active).toBeTruthy();

    const result = taskManager.cancelAllTasks();
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        reason: "cancelled",
        count: 2,
        taskIds: expect.arrayContaining([first.task.id, second.task.id]),
      }),
    );

    expect(taskManager.getTask(second.task.id)).toEqual(
      expect.objectContaining({
        id: second.task.id,
        status: "cancelled",
        message: "知识图谱构建已取消",
      }),
    );

    const cancelled = await waitFor(() => {
      const task = taskManager.getTask(first.task.id);
      return task?.status === "cancelled" ? task : null;
    }, 2000);

    expect(cancelled).toEqual(
      expect.objectContaining({
        id: first.task.id,
        status: "cancelled",
        result: null,
      }),
    );
    expect(taskManager.getTaskState()).toEqual({
      is_building: false,
      building_progress: 0,
      building_message: null,
      current_task_id: null,
      current_task_status: null,
      queued_task_count: 0,
      queued_task_ids: [],
      active_task_count: 0,
    });
  });

  it("restores task history after restart and marks unfinished tasks as cancelled", async () => {
    const dataDir = makeTempDir();
    const store = new GraphStore(dataDir);
    stores.push(store);

    const firstManager = new GraphTaskManager(store, { dataDir });
    const submission = firstManager.submitBuildTask({
      title: "Restart recovery graph",
      rebuild: true,
      documents: [
        { id: "doc-1", title: "Doc 1", text: "Alpha relates to Beta. Beta leads to Gamma." },
        { id: "doc-2", title: "Doc 2", text: "Gamma supports Delta. Delta connects Epsilon." },
        { id: "doc-3", title: "Doc 3", text: "Epsilon references Zeta. Zeta extends Eta." },
      ],
    });

    const active = await waitFor(() => {
      const task = firstManager.getTask(submission.task.id);
      if (!task) return null;
      return ["pending", "running", "cancelling"].includes(task.status) ? task : null;
    }, 2000);

    expect(active).toBeTruthy();
    firstManager.destroy();

    const reloadedManager = new GraphTaskManager(store, { dataDir });
    const recoveredTask = reloadedManager.getTask(submission.task.id);
    expect(recoveredTask).toEqual(
      expect.objectContaining({
        id: submission.task.id,
        status: "cancelled",
        progress: 0,
        message: "应用重启后，此知识图谱构建任务已中断，请重新发起。",
        result: null,
      }),
    );
    expect(reloadedManager.getTaskState()).toEqual({
      is_building: false,
      building_progress: 0,
      building_message: null,
      current_task_id: null,
      current_task_status: null,
      queued_task_count: 0,
      queued_task_ids: [],
      active_task_count: 0,
    });

    reloadedManager.destroy();
  });
});
