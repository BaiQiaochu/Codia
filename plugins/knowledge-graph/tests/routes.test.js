import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../lib/graph-store.js";
import { GraphTaskManager } from "../lib/graph-task-manager.js";
import { renderGraphHtml } from "../lib/render-graph-html.js";
import registerCardRoutes from "../routes/card.js";
import registerGraphRoutes from "../routes/graph.js";
import registerPageRoutes from "../routes/page.js";

let tempDirs = [];
let stores = [];

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

function parseNodeTranslate(element) {
  const match = String(element?.getAttribute("transform") || "").match(/translate\(([-\d.]+),([-\d.]+)\)/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-kg-routes-"));
  tempDirs.push(dataDir);

  const store = new GraphStore(dataDir);
  const taskManager = new GraphTaskManager(store);
  stores.push(store);

  const app = new Hono();
  const ctx = {
    pluginId: "knowledge-graph",
    dataDir,
    _knowledgeGraph: {
      store,
      taskManager,
    },
  };

  registerGraphRoutes(app, ctx);
  registerCardRoutes(app, ctx);
  registerPageRoutes(app, ctx);
  return { app, ctx, store, taskManager };
}

async function readJson(response) {
  return response.json();
}

async function submitBuild(app, body) {
  const response = await app.request("/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(202);
  return readJson(response);
}

async function waitForTask(app, taskId, timeout = 2000) {
  const task = await waitFor(async () => {
    const response = await app.request(`/tasks/${encodeURIComponent(taskId)}`);
    if (response.status !== 200) return null;
    const data = await response.json();
    if (
      data.status === "queued" ||
      data.status === "pending" ||
      data.status === "running" ||
      data.status === "cancelling"
    ) {
      return null;
    }
    return data;
  }, timeout);

  if (!task) {
    throw new Error(`task ${taskId} did not complete in time`);
  }

  return task;
}

async function buildAndWait(app, body) {
  const submission = await submitBuild(app, body);
  const task = await waitForTask(app, submission.task.id);
  expect(task.status).toBe("completed");
  return { submission, task };
}

function makeGraphSnapshot({
  title,
  lastBuiltAt,
  nodes,
  edges,
  sources,
  archiveId = null,
}) {
  return {
    version: 2,
    title,
    last_built_at: lastBuiltAt,
    nodes,
    edges,
    sources,
    is_archive: Boolean(archiveId),
    archive_id: archiveId,
    archive_title: archiveId ? title : null,
    archived_at: archiveId ? "2026-05-02T10:10:00.000Z" : null,
  };
}

function makeStatus({
  graph,
  isBuilding = false,
  progress = 0,
  taskId = null,
  taskStatus = null,
  archiveCount = 0,
  queuedTaskIds = [],
}) {
  const normalizedQueuedTaskIds = Array.isArray(queuedTaskIds) ? queuedTaskIds.filter(Boolean) : [];
  const currentTaskStatus = taskId ? taskStatus || (isBuilding ? "running" : "pending") : null;
  return {
    has_llm_config: true,
    llm_required: false,
    graph_exists: graph.nodes.length > 0,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    source_count: graph.sources.length,
    is_building: isBuilding,
    building_progress: isBuilding ? progress : graph.nodes.length > 0 ? 100 : 0,
    building_message: isBuilding ? "正在构建知识图谱..." : null,
    current_task_id: taskId,
    current_task_status: currentTaskStatus,
    queued_task_count: normalizedQueuedTaskIds.length,
    queued_task_ids: normalizedQueuedTaskIds,
    active_task_count: (taskId ? 1 : 0) + normalizedQueuedTaskIds.length,
    last_built_at: graph.last_built_at,
    storage: "local-json",
    model: "sparknote-inspired-local",
    archive_count: archiveCount,
    current_title: graph.title || "知识图谱",
  };
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

describe("knowledge graph plugin routes", () => {
  it("builds graph data asynchronously and serves linked source documents", async () => {
    const { app } = makeApp();

    const { submission, task } = await buildAndWait(app, {
      title: "Conversation graph",
      rebuild: true,
      documents: [
        { id: "doc-alpha", title: "Alpha source", text: "Alpha relates to Beta." },
        {
          id: "doc-spark",
          title: "Spark source",
          text: "SparkNoteAI inspired the graph data model rewrite.",
        },
      ],
    });

    expect(submission.ok).toBe(true);
    expect(submission.task).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        type: "knowledge_graph_build",
      }),
    );
    expect(["pending", "running"]).toContain(submission.task.status);
    expect(submission.status).toEqual(
      expect.objectContaining({
        is_building: true,
        current_task_id: submission.task.id,
      }),
    );

    expect(task.result).toEqual(
      expect.objectContaining({
        sourceIds: ["doc-alpha", "doc-spark"],
        stats: expect.objectContaining({
          node_count: expect.any(Number),
          edge_count: expect.any(Number),
          source_count: 2,
        }),
      }),
    );

    const statusRes = await app.request("/status");
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual(
      expect.objectContaining({
        graph_exists: true,
        node_count: task.result.stats.node_count,
        edge_count: task.result.stats.edge_count,
        source_count: 2,
        storage: "local-json",
        model: "sparknote-inspired-local",
        is_building: false,
        current_task_id: null,
        archive_count: 0,
      }),
    );

    const taskListRes = await app.request("/tasks?limit=1");
    expect(taskListRes.status).toBe(200);
    expect(await taskListRes.json()).toEqual({
      tasks: [expect.objectContaining({ id: submission.task.id, status: "completed" })],
    });

    const statsRes = await app.request("/stats");
    expect(statsRes.status).toBe(200);
    expect(await statsRes.json()).toEqual(
      expect.objectContaining({
        graph_exists: true,
        node_count: task.result.stats.node_count,
        edge_count: task.result.stats.edge_count,
        source_count: 2,
        connected_nodes: expect.any(Number),
        isolated_nodes: expect.any(Number),
        avg_degree: expect.any(Number),
      }),
    );

    const nodes = await (await app.request("/nodes")).json();
    const edges = await (await app.request("/edges")).json();
    expect(nodes).toHaveLength(task.result.stats.node_count);
    expect(edges).toHaveLength(task.result.stats.edge_count);

    const alphaNode = nodes.find((node) => node.name === "Alpha") || nodes[0];
    expect(alphaNode).toBeTruthy();
    expect(alphaNode.source_note_ids).toContain("doc-alpha");

    const sourceRes = await app.request(`/nodes/${encodeURIComponent(alphaNode.id)}/sources`);
    expect(sourceRes.status).toBe(200);
    expect(await sourceRes.json()).toEqual(
      expect.objectContaining({
        node: expect.objectContaining({
          id: alphaNode.id,
          name: alphaNode.name,
        }),
        sources: [
          expect.objectContaining({
            id: "doc-alpha",
            title: "Alpha source",
            text: expect.stringContaining("Alpha relates to Beta."),
          }),
        ],
      }),
    );

    const dataRes = await app.request("/data");
    expect(dataRes.status).toBe(200);
    expect(await dataRes.json()).toEqual(
      expect.objectContaining({
        version: 2,
        nodes: expect.any(Array),
        edges: expect.any(Array),
        sources: expect.any(Array),
        is_archive: false,
        archive_id: null,
      }),
    );
  });

  it("archives the previous graph on rebuild and supports browse, restore, and delete", async () => {
    const { app } = makeApp();

    await buildAndWait(app, {
      title: "Alpha graph",
      rebuild: true,
      documents: [{ id: "doc-alpha", title: "Alpha source", text: "Alpha relates to Beta." }],
    });

    const second = await buildAndWait(app, {
      title: "Gamma graph",
      rebuild: true,
      archiveTitle: "Alpha graph snapshot",
      archiveReason: "rebuild",
      documents: [{ id: "doc-gamma", title: "Gamma source", text: "Gamma leads to Delta." }],
    });

    expect(second.task.result.archived).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: "Alpha graph snapshot",
        reason: "rebuild",
        source: "rebuild",
      }),
    );

    const archiveId = second.task.result.archived.id;
    const archivesRes = await app.request("/archives");
    expect(archivesRes.status).toBe(200);
    const archivesData = await archivesRes.json();
    expect(archivesData.archives).toEqual([
      expect.objectContaining({
        id: archiveId,
        title: "Alpha graph snapshot",
      }),
    ]);

    const archiveRes = await app.request(`/archives/${encodeURIComponent(archiveId)}`);
    expect(archiveRes.status).toBe(200);
    const archivePayload = await archiveRes.json();
    expect(archivePayload.archive).toEqual(expect.objectContaining({ id: archiveId }));
    expect(archivePayload.graph).toEqual(
      expect.objectContaining({
        is_archive: true,
        archive_id: archiveId,
        nodes: expect.arrayContaining([expect.objectContaining({ name: "Alpha" })]),
      }),
    );

    const archiveDataRes = await app.request(`/data?archiveId=${encodeURIComponent(archiveId)}`);
    expect(archiveDataRes.status).toBe(200);
    expect(await archiveDataRes.json()).toEqual(
      expect.objectContaining({
        is_archive: true,
        archive_id: archiveId,
        nodes: expect.arrayContaining([expect.objectContaining({ name: "Alpha" })]),
      }),
    );

    const currentGraph = await (await app.request("/data")).json();
    expect(currentGraph.nodes.some((node) => node.name === "Gamma")).toBe(true);
    expect(currentGraph.nodes.some((node) => node.name === "Alpha")).toBe(false);

    const readonlyDeleteRes = await app.request(`/nodes/1?archiveId=${encodeURIComponent(archiveId)}`, {
      method: "DELETE",
    });
    expect(readonlyDeleteRes.status).toBe(400);
    expect((await readonlyDeleteRes.json()).error).toBeTruthy();

    const restoreRes = await app.request(`/archives/${encodeURIComponent(archiveId)}/restore`, {
      method: "POST",
    });
    expect(restoreRes.status).toBe(200);
    const restored = await restoreRes.json();
    expect(restored).toEqual(
      expect.objectContaining({
        ok: true,
        archive: expect.objectContaining({ id: archiveId }),
        backup_archive: expect.objectContaining({
          id: expect.any(String),
          source: "restore-backup",
        }),
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ name: "Alpha" })]),
        }),
      }),
    );

    const currentAfterRestore = await (await app.request("/data")).json();
    expect(currentAfterRestore.nodes.some((node) => node.name === "Alpha")).toBe(true);
    expect(currentAfterRestore.nodes.some((node) => node.name === "Gamma")).toBe(false);

    const deleteArchiveRes = await app.request(`/archives/${encodeURIComponent(archiveId)}`, {
      method: "DELETE",
    });
    expect(deleteArchiveRes.status).toBe(200);
    const afterDelete = await deleteArchiveRes.json();
    expect(afterDelete.ok).toBe(true);
    expect(afterDelete.archives.some((item) => item.id === archiveId)).toBe(false);
  });

  it("supports deleting edges and nodes, and clearing the current graph without deleting archives", async () => {
    const { app } = makeApp();

    await buildAndWait(app, {
      title: "Editable graph",
      rebuild: true,
      text: "Alpha relates to Beta. Beta leads to Gamma.",
    });

    const archiveCreateRes = await app.request("/archives/current", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Editable graph snapshot" }),
    });
    expect(archiveCreateRes.status).toBe(200);
    const archiveCreate = await archiveCreateRes.json();
    expect(archiveCreate.archive).toEqual(
      expect.objectContaining({
        title: "Editable graph snapshot",
        source: "manual",
      }),
    );

    const beforeEdit = await (await app.request("/data")).json();
    const firstEdge = beforeEdit.edges[0];
    const betaNode = beforeEdit.nodes.find((node) => node.name === "Beta") || beforeEdit.nodes[0];
    expect(firstEdge).toBeTruthy();
    expect(betaNode).toBeTruthy();

    const deleteEdgeRes = await app.request(`/edges/${encodeURIComponent(firstEdge.id)}`, {
      method: "DELETE",
    });
    expect(deleteEdgeRes.status).toBe(200);
    expect(await deleteEdgeRes.json()).toEqual({ ok: true });

    const edgesAfterDelete = await (await app.request("/edges")).json();
    expect(edgesAfterDelete).toHaveLength(beforeEdit.edges.length - 1);

    const deleteNodeRes = await app.request(`/nodes/${encodeURIComponent(betaNode.id)}`, {
      method: "DELETE",
    });
    expect(deleteNodeRes.status).toBe(200);
    expect(await deleteNodeRes.json()).toEqual({ ok: true });

    const nodesAfterDelete = await (await app.request("/nodes")).json();
    expect(nodesAfterDelete.some((node) => node.id === betaNode.id)).toBe(false);

    const clearRes = await app.request("/data", { method: "DELETE" });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual(
      expect.objectContaining({
        ok: true,
        graph: expect.objectContaining({
          version: 2,
          nodes: [],
          edges: [],
          sources: [],
        }),
        archives: [expect.objectContaining({ title: "Editable graph snapshot" })],
      }),
    );

    const archivesRes = await app.request("/archives");
    expect(archivesRes.status).toBe(200);
    expect((await archivesRes.json()).archives).toHaveLength(1);

    const emptyRes = await app.request("/data");
    expect(await emptyRes.json()).toEqual(
      expect.objectContaining({
        version: 2,
        nodes: [],
        edges: [],
        sources: [],
      }),
    );
  });

  it("returns errors for malformed JSON, empty build requests, queued builds, and missing graph items", async () => {
    const { app } = makeApp();

    const invalidJsonRes = await app.request("/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    });
    expect(invalidJsonRes.status).toBe(400);
    expect(await invalidJsonRes.json()).toEqual({ error: "invalid JSON body" });

    const emptyBuildRes = await app.request("/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Empty graph" }),
    });
    expect(emptyBuildRes.status).toBe(400);
    expect((await emptyBuildRes.json()).error).toBeTruthy();

    const firstBuild = await submitBuild(app, {
      title: "Busy graph",
      text: "Alpha relates to Beta.",
      rebuild: true,
    });

    const secondBuildRes = await app.request("/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Busy graph second",
        text: "Gamma leads to Delta.",
        rebuild: true,
      }),
    });
    expect(secondBuildRes.status).toBe(202);
    const secondBuild = await secondBuildRes.json();
    expect(secondBuild).toEqual(
      expect.objectContaining({
        ok: true,
        queued: true,
        task: expect.objectContaining({
          id: expect.any(String),
          status: "queued",
          queue_position: 1,
        }),
        status: expect.objectContaining({
          is_building: true,
          current_task_id: firstBuild.task.id,
          current_task_status: expect.stringMatching(/pending|running/),
          queued_task_count: 1,
          queued_task_ids: [expect.any(String)],
          active_task_count: 2,
        }),
      }),
    );
    expect(secondBuild.task.id).not.toBe(firstBuild.task.id);
    expect(secondBuild.status.queued_task_ids).toEqual([secondBuild.task.id]);

    const firstTask = await waitForTask(app, firstBuild.task.id);
    const secondTask = await waitForTask(app, secondBuild.task.id, 3000);
    expect(firstTask.status).toBe("completed");
    expect(secondTask.status).toBe("completed");

    const taskListRes = await app.request("/tasks?limit=5");
    expect(taskListRes.status).toBe(200);
    expect((await taskListRes.json()).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstBuild.task.id, status: "completed" }),
        expect.objectContaining({ id: secondBuild.task.id, status: "completed" }),
      ]),
    );

    const missingTaskRes = await app.request("/tasks/not-found");
    expect(missingTaskRes.status).toBe(404);
    expect((await missingTaskRes.json()).error).toBeTruthy();

    const missingSourceRes = await app.request("/nodes/999/sources");
    expect(missingSourceRes.status).toBe(404);
    expect((await missingSourceRes.json()).error).toBeTruthy();

    const missingDeleteNodeRes = await app.request("/nodes/999", { method: "DELETE" });
    expect(missingDeleteNodeRes.status).toBe(404);
    expect((await missingDeleteNodeRes.json()).error).toBeTruthy();

    const missingDeleteEdgeRes = await app.request("/edges/999", { method: "DELETE" });
    expect(missingDeleteEdgeRes.status).toBe(404);
    expect((await missingDeleteEdgeRes.json()).error).toBeTruthy();
  });

  it("cancels an active build task through the API and clears build status", async () => {
    const { app } = makeApp();
    const documents = Array.from({ length: 24 }, (_, index) => ({
      id: `doc-${index + 1}`,
      title: `Doc ${index + 1}`,
      text:
        `Node ${index + 1} relates to Node ${index + 2}. ` +
        `Node ${index + 2} references Topic ${index + 1}. ` +
        `Topic ${index + 1} connects Entity ${index + 1}.`,
    }));

    const submission = await submitBuild(app, {
      title: "Cancelable route graph",
      rebuild: true,
      documents,
    });

    const running = await waitFor(async () => {
      const response = await app.request(`/tasks/${encodeURIComponent(submission.task.id)}`);
      if (response.status !== 200) return null;
      const task = await response.json();
      if (task.status === "cancelling") return task;
      return task.status === "running" && Number(task.progress) < 90 ? task : null;
    }, 2000);

    expect(running).toBeTruthy();

    const cancelRes = await app.request(`/tasks/${encodeURIComponent(submission.task.id)}/cancel`, {
      method: "POST",
    });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual(
      expect.objectContaining({
        ok: true,
        task: expect.objectContaining({
          id: submission.task.id,
          status: expect.stringMatching(/cancelling|cancelled/),
        }),
      }),
    );

    const cancelled = await waitForTask(app, submission.task.id);
    expect(cancelled.status).toBe("cancelled");

    const statusRes = await app.request("/status");
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual(
      expect.objectContaining({
        is_building: false,
        current_task_id: null,
      }),
    );
  });

  it("cancels the current build and queued builds through the bulk cancel API", async () => {
    const { app } = makeApp();
    const documents = Array.from({ length: 24 }, (_, index) => ({
      id: `doc-${index + 1}`,
      title: `Doc ${index + 1}`,
      text:
        `Node ${index + 1} relates to Node ${index + 2}. ` +
        `Node ${index + 2} references Topic ${index + 1}. ` +
        `Topic ${index + 1} connects Entity ${index + 1}.`,
    }));

    const firstBuild = await submitBuild(app, {
      title: "Bulk cancel route graph",
      rebuild: true,
      documents,
      parentSessionPath: "E:/sessions/one.jsonl",
    });
    const secondBuild = await submitBuild(app, {
      title: "Queued route graph",
      text: "Queued graph for cancellation.",
      rebuild: true,
      parentSessionPath: "E:/sessions/two.jsonl",
    });

    const running = await waitFor(async () => {
      const response = await app.request(`/tasks/${encodeURIComponent(firstBuild.task.id)}`);
      if (response.status !== 200) return null;
      const task = await response.json();
      if (task.status === "cancelling") return task;
      return task.status === "running" && Number(task.progress) < 90 ? task : null;
    }, 2000);

    expect(running).toBeTruthy();

    const taskListBefore = await app.request("/tasks?limit=5");
    expect(taskListBefore.status).toBe(200);
    expect((await taskListBefore.json()).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstBuild.task.id }),
        expect.objectContaining({ id: secondBuild.task.id, status: "queued" }),
      ]),
    );

    const cancelRes = await app.request("/tasks/cancel-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual(
      expect.objectContaining({
        ok: true,
        reason: "cancelled",
        cancelled_count: 2,
        task_ids: expect.arrayContaining([firstBuild.task.id, secondBuild.task.id]),
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: firstBuild.task.id, status: expect.stringMatching(/cancelling|cancelled/) }),
          expect.objectContaining({ id: secondBuild.task.id, status: "cancelled" }),
        ]),
      }),
    );

    const firstCancelled = await waitForTask(app, firstBuild.task.id);
    expect(firstCancelled.status).toBe("cancelled");

    const secondTaskRes = await app.request(`/tasks/${encodeURIComponent(secondBuild.task.id)}`);
    expect(secondTaskRes.status).toBe(200);
    expect(await secondTaskRes.json()).toEqual(
      expect.objectContaining({
        id: secondBuild.task.id,
        status: "cancelled",
      }),
    );

    const statusRes = await app.request("/status");
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual(
      expect.objectContaining({
        is_building: false,
        current_task_id: null,
        queued_task_count: 0,
      }),
    );
  });

  it("serves interactive card and page html with archive and async task controls", async () => {
    const { app } = makeApp();

    const cardRes = await app.request("/card?token=card-token");
    const pageRes = await app.request("/page?token=page-token");

    expect(cardRes.status).toBe(200);
    expect(pageRes.status).toBe(200);

    const cardHtml = await cardRes.text();
    const pageHtml = await pageRes.text();

    expect(cardHtml).toContain('var TOKEN = "card-token";');
    expect(pageHtml).toContain('var TOKEN = "page-token";');
    expect(pageHtml).toContain('id="archiveCurrent"');
    expect(pageHtml).toContain('id="archiveList"');
    expect(pageHtml).toContain('id="viewCurrent"');
    expect(pageHtml).toContain('id="cancelBuild"');
    expect(pageHtml).toContain('id="cancelAllTasks"');
    expect(pageHtml).toContain('function renderArchives()');
    expect(pageHtml).toContain('function watchTask(taskId)');
    expect(pageHtml).toContain('function cancelAllBuildTasks()');
    expect(pageHtml).toContain('"/archives/current"');
    expect(pageHtml).toContain('"/tasks/"');
    expect(pageHtml).toContain('"/cancel"');
    expect(pageHtml).toContain('"/tasks/cancel-all"');
    expect(pageHtml).toContain('await fetchJson("/build"');
    expect(pageHtml).toContain('withArchive("/nodes/" + encodeURIComponent(node.id) + "/sources")');
    expect(pageHtml).toContain('if (IS_PAGE && "ResizeObserver" in window)');
    expect(pageHtml).toContain("requestAnimationFrame");
    expect(pageHtml).toContain("pointerdown");
    expect(pageHtml).toContain("height:560px;");
    expect(pageHtml).toContain("function graphSafeBounds()");
    expect(pageHtml).toContain("function clampNodePosition(node, x, y)");
    expect(pageHtml).toContain("@keyframes kg-edge-flow");
    expect(pageHtml).toContain("var STRONG_EDGE_THRESHOLD = 0.7;");
    expect(pageHtml).toContain("function isStrongEdge(edge)");
    expect(pageHtml).toContain("grid-template-columns:minmax(0,1.45fr) minmax(360px,.85fr);");
    expect(pageHtml).toContain("align-self:stretch;");
    expect(pageHtml).toContain("background:var(--kg-input);");
    expect(pageHtml).toContain("color-mix(in srgb,var(--kg-panel)");
    expect(pageHtml).toContain("flex:0 0 auto;");
    expect(pageHtml).toContain("overflow:hidden;");
    expect(pageHtml).toContain(".edge-strong{");
    expect(pageHtml).toContain(".edge-weak{");
    expect(pageHtml).toContain("stroke-dasharray:7 7;");
    expect(pageHtml).toContain("prefers-reduced-motion:reduce");
    expect(pageHtml).not.toContain("/ask");

    const pageDoc = new JSDOM(pageHtml).window.document;
    expect(pageDoc.querySelector(".graph-column #graphCard")).toBeTruthy();
    expect(pageDoc.querySelector(".graph-column #sourceList")).toBeTruthy();
    expect(pageDoc.querySelector(".graph-column .legend")).toBeTruthy();
    expect(pageDoc.querySelector(".sidebar .builder-panel #buildText")).toBeTruthy();
    expect(pageDoc.querySelector(".graph-column .builder")).toBeNull();
    expect(pageDoc.querySelector(".sidebar #sourceList")).toBeNull();
    expect(pageDoc.querySelector(".sidebar .legend")).toBeNull();

    expect(cardHtml).toContain("var FIXED_WIDTH = 960;");
    expect(cardHtml).toContain("var FIXED_HEIGHT = 680;");
    expect(cardHtml).toContain("var GRAPH_VIEWPORT_HEIGHT = 500;");
    expect(cardHtml).toContain("height:500px;");
    expect(cardHtml).toContain('"edge " + (isStrongEdge(edge) ? "edge-strong" : "edge-weak")');
    expect(cardHtml).toContain("animation:kg-edge-flow 1.45s linear infinite;");
    expect(cardHtml).toContain('function renderArchives()');
    expect(cardHtml).toContain('"/tasks/"');
    expect(cardHtml).toContain('id="archiveCurrent"');
    expect(cardHtml).toContain('id="viewCurrent"');
    expect(cardHtml).toContain('id="clear"');
    expect(cardHtml).toContain('id="cancelAllTasks"');
  });

  it("renders strong relationships as solid edges and weaker relationships as dashed edges", async () => {
    const graph = makeGraphSnapshot({
      title: "Edge strength graph",
      lastBuiltAt: "2026-05-02T12:00:00.000Z",
      nodes: [
        { id: 1, name: "Alpha", node_type: "concept", description: "", source_note_ids: [] },
        { id: 2, name: "Beta", node_type: "entity", description: "", source_note_ids: [] },
        { id: 3, name: "Gamma", node_type: "topic", description: "", source_note_ids: [] },
      ],
      edges: [
        { id: "strong-edge", source_node_id: 1, target_node_id: 2, edge_type: "related", strength: 0.9 },
        { id: "weak-edge", source_node_id: 2, target_node_id: 3, edge_type: "related", strength: 0.35 },
      ],
      sources: [],
    });
    const status = makeStatus({ graph, archiveCount: 0 });

    const dom = new JSDOM(renderGraphHtml({ mode: "card" }), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "http://127.0.0.1/",
      beforeParse(window) {
        window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
        window.cancelAnimationFrame = (id) => window.clearTimeout(id);
        window.fetch = async (url, init = {}) => {
          const method = String(init.method || "GET").toUpperCase();
          const parsed = new URL(String(url), "http://127.0.0.1");
          const path = parsed.pathname.replace("/api/plugins/knowledge-graph", "");
          if (path === "/status") return { ok: true, json: async () => status };
          if (path === "/archives" && method === "GET") {
            return { ok: true, json: async () => ({ archives: [] }) };
          }
          if (path === "/tasks" && method === "GET") {
            return { ok: true, json: async () => ({ tasks: [] }) };
          }
          if (path === "/data" && method === "GET") {
            return { ok: true, json: async () => JSON.parse(JSON.stringify(graph)) };
          }
          throw new Error(`unexpected fetch: ${method} ${path}`);
        };
      },
    });

    try {
      await waitFor(() =>
        dom.window.document.querySelectorAll(".edge-strong").length === 1 &&
        dom.window.document.querySelectorAll(".edge-weak").length === 1,
      );

      expect(dom.window.document.querySelectorAll(".edge")).toHaveLength(2);
      expect(dom.window.document.querySelector(".edge-strong")).toBeTruthy();
      expect(dom.window.document.querySelector(".edge-weak")).toBeTruthy();
    } finally {
      dom.window.close();
    }
  });

  it("card mode supports deleting archives and clearing the current graph", async () => {
    const emptyGraph = makeGraphSnapshot({
      title: "Knowledge graph",
      lastBuiltAt: null,
      nodes: [],
      edges: [],
      sources: [],
    });
    const currentGraphSnapshot = makeGraphSnapshot({
      title: "Current graph",
      lastBuiltAt: "2026-05-02T12:00:00.000Z",
      nodes: [
        { id: 1, name: "Alpha", node_type: "entity", description: "Alpha node", source_note_ids: ["doc-1"] },
        { id: 2, name: "Beta", node_type: "concept", description: "Beta node", source_note_ids: ["doc-1"] },
      ],
      edges: [
        {
          id: "edge-1",
          source_node_id: 1,
          target_node_id: 2,
          strength: 0.7,
          description: "relates to",
        },
      ],
      sources: [
        { id: "doc-1", title: "Doc 1", text: "Alpha relates to Beta." },
      ],
    });

    let currentGraph = JSON.parse(JSON.stringify(currentGraphSnapshot));
    let archives = [
      {
        id: "archive-1",
        title: "Archive one",
        created_at: "2026-05-02T11:00:00.000Z",
        node_count: 1,
        edge_count: 0,
        graph: makeGraphSnapshot({
          title: "Archive one",
          lastBuiltAt: "2026-05-02T11:00:00.000Z",
          nodes: [
            { id: 10, name: "Archived", node_type: "topic", description: "Archived node", source_note_ids: [] },
          ],
          edges: [],
          sources: [],
          archiveId: "archive-1",
        }),
      },
    ];
    let status = makeStatus({ graph: currentGraph, archiveCount: archives.length });

    const dom = new JSDOM(renderGraphHtml({ mode: "card" }), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "http://127.0.0.1/",
      beforeParse(window) {
        window.confirm = () => true;
        window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
        window.cancelAnimationFrame = (id) => window.clearTimeout(id);
        window.fetch = async (url, init = {}) => {
          const href = String(url);
          const method = String(init.method || "GET").toUpperCase();
          const parsed = new URL(href, "http://127.0.0.1");
          const path = parsed.pathname.replace("/api/plugins/knowledge-graph", "");
          const archiveId = parsed.searchParams.get("archiveId");

          if (path === "/status") {
            return { ok: true, json: async () => status };
          }

          if (path === "/archives" && method === "GET") {
            return {
              ok: true,
              json: async () => ({
                archives: archives.map(({ graph: _graph, ...archive }) => archive),
              }),
            };
          }

          if (path === "/data" && method === "GET") {
            const archive = archiveId ? archives.find((item) => item.id === archiveId) : null;
            return {
              ok: true,
              json: async () => JSON.parse(JSON.stringify(archive ? archive.graph : currentGraph)),
            };
          }

          if (path.startsWith("/archives/") && method === "DELETE") {
            const archiveIdToDelete = decodeURIComponent(path.slice("/archives/".length));
            archives = archives.filter((archive) => archive.id !== archiveIdToDelete);
            status = makeStatus({ graph: currentGraph, archiveCount: archives.length });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                archives: archives.map(({ graph: _graph, ...archive }) => archive),
              }),
            };
          }

          if (path === "/data" && method === "DELETE") {
            currentGraph = JSON.parse(JSON.stringify(emptyGraph));
            status = makeStatus({ graph: currentGraph, archiveCount: archives.length });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                graph: currentGraph,
                archives: archives.map(({ graph: _graph, ...archive }) => archive),
              }),
            };
          }

          if (path === "/tasks" && method === "GET") {
            return { ok: true, json: async () => ({ tasks: [] }) };
          }

          throw new Error(`unexpected fetch: ${method} ${path}`);
        };
      },
    });

    try {
      const clearButton = await waitFor(() => dom.window.document.querySelector("#clear"));
      const statNodes = dom.window.document.querySelector("#statNodes");

      await waitFor(() => dom.window.document.querySelector('.archive-card[data-archive-id="archive-1"]'));

      const getArchiveCard = () =>
        dom.window.document.querySelector('.archive-card[data-archive-id="archive-1"]');
      const archiveDeleteButton = getArchiveCard()?.querySelector("button.danger");
      archiveDeleteButton.click();

      await waitFor(() => !getArchiveCard());
      expect(dom.window.document.querySelectorAll(".archive-card")).toHaveLength(0);
      expect(statNodes.textContent).toBe("2");

      clearButton.click();
      await waitFor(() => statNodes.textContent === "0");
      expect(dom.window.document.querySelectorAll(".node")).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it("page mode supports async builds, archive browsing, source browsing, node deletion, and clear", async () => {
    const emptyGraph = makeGraphSnapshot({
      title: "知识图谱",
      lastBuiltAt: null,
      nodes: [],
      edges: [],
      sources: [],
    });
    const alphaGraph = makeGraphSnapshot({
      title: "Build one",
      lastBuiltAt: "2026-05-02T10:00:00.000Z",
      nodes: [
        {
          id: 1,
          name: "Alpha",
          node_type: "concept",
          description: "Alpha node",
          source_note_ids: ["source-a"],
        },
        {
          id: 2,
          name: "Beta",
          node_type: "entity",
          description: "Beta node",
          source_note_ids: ["source-a"],
        },
      ],
      edges: [
        {
          id: 11,
          source_node_id: 1,
          target_node_id: 2,
          edge_type: "related",
          description: "Alpha-Beta",
          strength: 0.7,
        },
      ],
      sources: [{ id: "source-a", title: "Alpha source", text: "Alpha source document" }],
    });

    let currentGraph = JSON.parse(JSON.stringify(emptyGraph));
    let archives = [];
    let status = makeStatus({ graph: currentGraph, archiveCount: 0 });
    const buildCalls = [];
    const deletedNodeIds = [];
    const taskPhases = new Map();
    let archiveSequence = 0;

    const makeArchive = (graph, title = "") => {
      archiveSequence += 1;
      const archiveId = `archive-${archiveSequence}`;
      const snapshot = JSON.parse(JSON.stringify(graph));
      const archive = {
        id: archiveId,
        title: title || snapshot.title,
        reason: "manual",
        source: "manual",
        created_at: `2026-05-02T10:0${archiveSequence}:00.000Z`,
        updated_at: `2026-05-02T10:0${archiveSequence}:00.000Z`,
        last_built_at: snapshot.last_built_at,
        node_count: snapshot.nodes.length,
        edge_count: snapshot.edges.length,
        source_count: snapshot.sources.length,
        graph: snapshot,
      };
      archives = [archive, ...archives];
      status = makeStatus({ graph: currentGraph, archiveCount: archives.length });
      return archive;
    };

    const graphForArchiveId = (archiveId) => {
      const archive = archives.find((item) => item.id === archiveId);
      if (!archive) return null;
      return {
        ...JSON.parse(JSON.stringify(archive.graph)),
        is_archive: true,
        archive_id: archive.id,
        archive_title: archive.title,
        archived_at: archive.created_at,
      };
    };

    const sourcePayloadForNode = (graph, nodeId, archiveId = null) => {
      const node = graph.nodes.find((item) => item.id === nodeId);
      if (!node) return { node: null, sources: [] };
      return {
        node,
        sources: graph.sources.filter((source) => node.source_note_ids.includes(source.id)),
        archive_id: archiveId,
        is_archive: Boolean(archiveId),
      };
    };

    const listTaskPayloads = () =>
      [...taskPhases.entries()]
        .map(([taskId, phase]) => {
          if (phase === 0) {
            return {
              id: taskId,
              type: "knowledge_graph_build",
              status: "pending",
              progress: 0,
              message: "等待开始",
              created_at: "2026-05-02T10:00:00.000Z",
              updated_at: "2026-05-02T10:00:00.000Z",
            };
          }
          if (phase === 1) {
            return {
              id: taskId,
              type: "knowledge_graph_build",
              status: "running",
              progress: 48,
              message: "正在抽取节点与关系...",
              created_at: "2026-05-02T10:00:00.000Z",
              updated_at: "2026-05-02T10:00:05.000Z",
            };
          }
          return {
            id: taskId,
            type: "knowledge_graph_build",
            status: "completed",
            progress: 100,
            message: "知识图谱构建完成",
            created_at: "2026-05-02T10:00:00.000Z",
            updated_at: "2026-05-02T10:00:10.000Z",
            result: {
              stats: {
                node_count: currentGraph.nodes.length,
                edge_count: currentGraph.edges.length,
                source_count: currentGraph.sources.length,
              },
            },
          };
        })
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));

    const dom = new JSDOM(renderGraphHtml({ mode: "page" }), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "http://127.0.0.1/",
      beforeParse(window) {
        window.confirm = () => true;
        window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
        window.cancelAnimationFrame = (id) => window.clearTimeout(id);
        window.fetch = async (url, init = {}) => {
          const href = String(url);
          const method = String(init.method || "GET").toUpperCase();
          const parsed = new URL(href, "http://127.0.0.1");
          const path = parsed.pathname.replace("/api/plugins/knowledge-graph", "");
          const archiveId = parsed.searchParams.get("archiveId");

          if (path === "/status") {
            return { ok: true, json: async () => status };
          }

          if (path === "/archives" && method === "GET") {
            return {
              ok: true,
              json: async () => ({
                archives: archives.map(({ graph: _graph, ...archive }) => archive),
              }),
            };
          }

          if (path === "/archives/current" && method === "POST") {
            const archive = makeArchive(currentGraph, "Manual snapshot");
            return {
              ok: true,
              json: async () => ({
                ok: true,
                archive: { ...archive, graph: undefined },
                archives: archives.map(({ graph: _graph, ...item }) => item),
              }),
            };
          }

          if (path.startsWith("/archives/") && method === "DELETE") {
            const archiveIdToDelete = decodeURIComponent(path.slice("/archives/".length));
            archives = archives.filter((archive) => archive.id !== archiveIdToDelete);
            status = makeStatus({ graph: currentGraph, archiveCount: archives.length });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                archives: archives.map(({ graph: _graph, ...item }) => item),
              }),
            };
          }

          if (path === "/build" && method === "POST") {
            const body = JSON.parse(init.body || "{}");
            buildCalls.push(body);
            const taskId = `task-${buildCalls.length}`;
            taskPhases.set(taskId, 0);
            status = makeStatus({
              graph: currentGraph,
              isBuilding: true,
              progress: 0,
              taskId,
              taskStatus: "pending",
              archiveCount: archives.length,
            });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                task: {
                  id: taskId,
                  type: "knowledge_graph_build",
                  status: "pending",
                  progress: 0,
                  message: "等待开始",
                },
                status,
              }),
            };
          }

          if (path === "/tasks" && method === "GET") {
            const limit = Number(parsed.searchParams.get("limit") || 20) || 20;
            return {
              ok: true,
              json: async () => ({
                tasks: listTaskPayloads().slice(0, limit),
              }),
            };
          }

          if (path.startsWith("/tasks/") && method === "GET") {
            const taskId = path.split("/tasks/")[1];
            const phase = taskPhases.get(taskId) || 0;
            if (phase === 0) {
              taskPhases.set(taskId, 1);
              status = makeStatus({
                graph: currentGraph,
                isBuilding: true,
                progress: 48,
                taskId,
                taskStatus: "running",
                archiveCount: archives.length,
              });
              return {
                ok: true,
                json: async () => ({
                  id: taskId,
                  type: "knowledge_graph_build",
                  status: "running",
                  progress: 48,
                  message: "正在抽取节点与关系...",
                }),
              };
            }

            currentGraph = JSON.parse(JSON.stringify(alphaGraph));
            status = makeStatus({
              graph: currentGraph,
              isBuilding: false,
              progress: 100,
              taskId: null,
              archiveCount: archives.length,
            });
            taskPhases.set(taskId, 2);
            return {
              ok: true,
              json: async () => ({
                id: taskId,
                type: "knowledge_graph_build",
                status: "completed",
                progress: 100,
                message: "知识图谱构建完成",
                result: {
                  stats: {
                    node_count: currentGraph.nodes.length,
                    edge_count: currentGraph.edges.length,
                    source_count: currentGraph.sources.length,
                  },
                },
              }),
            };
          }

          if (path === "/data" && method === "GET") {
            const graph = archiveId ? graphForArchiveId(archiveId) : currentGraph;
            return {
              ok: true,
              json: async () => JSON.parse(JSON.stringify(graph || emptyGraph)),
            };
          }

          if (path === "/data" && method === "DELETE") {
            currentGraph = JSON.parse(JSON.stringify(emptyGraph));
            status = makeStatus({ graph: currentGraph, archiveCount: archives.length });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                graph: currentGraph,
                archives: archives.map(({ graph: _graph, ...item }) => item),
              }),
            };
          }

          if (path.startsWith("/nodes/") && path.endsWith("/sources")) {
            const nodeId = Number(path.split("/nodes/")[1].split("/sources")[0]);
            const graph = archiveId ? graphForArchiveId(archiveId) : currentGraph;
            return {
              ok: true,
              json: async () => sourcePayloadForNode(graph, nodeId, archiveId),
            };
          }

          if (path.startsWith("/nodes/") && method === "DELETE") {
            const nodeId = Number(path.split("/nodes/")[1]);
            deletedNodeIds.push(nodeId);
            currentGraph = {
              ...currentGraph,
              nodes: currentGraph.nodes.filter((node) => node.id !== nodeId),
              edges: currentGraph.edges.filter(
                (edge) => edge.source_node_id !== nodeId && edge.target_node_id !== nodeId,
              ),
            };
            status = makeStatus({ graph: currentGraph, archiveCount: archives.length });
            return {
              ok: true,
              json: async () => ({ ok: true }),
            };
          }

          throw new Error(`unexpected fetch: ${method} ${path}`);
        };
      },
    });

    try {
      const textarea = await waitFor(() => dom.window.document.querySelector("#buildText"));
      const buildButton = dom.window.document.querySelector("#build");
      const archiveCurrentButton = dom.window.document.querySelector("#archiveCurrent");
      const viewCurrentButton = dom.window.document.querySelector("#viewCurrent");
      const deleteButton = dom.window.document.querySelector("#deleteNode");
      const clearButton = dom.window.document.querySelector("#clear");
      const statNodes = dom.window.document.querySelector("#statNodes");

      textarea.value = "Alpha relates to Beta";
      buildButton.click();

      await waitFor(
        () =>
          buildCalls.length === 1 &&
          dom.window.document.querySelectorAll(".node").length === 2 &&
          buildButton.disabled === false,
      );

      expect(buildButton.disabled).toBe(false);
      expect(statNodes.textContent).toBe("2");
      expect(dom.window.document.querySelectorAll(".edge-strong")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll(".edge-weak")).toHaveLength(0);
      [...dom.window.document.querySelectorAll(".node")].forEach((element) => {
        const point = parseNodeTranslate(element);
        expect(point).toBeTruthy();
        expect(point.x).toBeGreaterThanOrEqual(76);
        expect(point.x).toBeLessThanOrEqual(564);
        expect(point.y).toBeGreaterThanOrEqual(52);
        expect(point.y).toBeLessThanOrEqual(488);
      });

      const firstNode = [...dom.window.document.querySelectorAll(".node")].find(
        (element) => element.getAttribute("aria-label") === "Alpha",
      );
      firstNode.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await waitFor(() =>
        dom.window.document.querySelector(".source-card")?.textContent?.includes("Alpha source document"),
      );
      expect(dom.window.document.querySelector(".source-card")?.textContent).toContain(
        "Alpha source document",
      );

      archiveCurrentButton.click();
      await waitFor(() => dom.window.document.querySelector('.archive-card[data-archive-id="archive-1"]'));
      expect(dom.window.document.querySelectorAll(".archive-card")).toHaveLength(1);

      const getArchiveCard = () =>
        dom.window.document.querySelector('.archive-card[data-archive-id="archive-1"]');
      let archiveViewButton = getArchiveCard()?.querySelector("button");
      archiveViewButton.click();
      await waitFor(() => dom.window.document.querySelector(".archive-card.active"));
      expect(buildButton.disabled).toBe(true);

      viewCurrentButton.click();
      await waitFor(() => !dom.window.document.querySelector(".archive-card.active"));
      expect(buildButton.disabled).toBe(false);

      archiveViewButton = getArchiveCard()?.querySelector("button");
      archiveViewButton.click();
      await waitFor(() => getArchiveCard()?.classList.contains("active"));
      const archiveDeleteButton = getArchiveCard()?.querySelector("button.danger");
      archiveDeleteButton.click();
      await waitFor(() => !getArchiveCard() && !dom.window.document.querySelector(".archive-card.active"));
      expect(buildButton.disabled).toBe(false);
      expect(statNodes.textContent).toBe("2");

      firstNode.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await waitFor(() => deleteButton.disabled === false);
      deleteButton.click();
      await waitFor(() => deletedNodeIds.length === 1 && statNodes.textContent === "1");
      expect(deletedNodeIds).toEqual([1]);

      clearButton.click();
      await waitFor(() => statNodes.textContent === "0" && buildButton.disabled === false);
      expect(dom.window.document.querySelectorAll(".node")).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it("page mode supports cancelling async builds and restores controls", async () => {
    const emptyGraph = makeGraphSnapshot({
      title: "Knowledge graph",
      lastBuiltAt: null,
      nodes: [],
      edges: [],
      sources: [],
    });

    const currentGraph = JSON.parse(JSON.stringify(emptyGraph));
    let status = makeStatus({ graph: currentGraph, archiveCount: 0 });
    const buildCalls = [];
    const cancelCalls = [];
    let cancelledRequested = false;
    let taskPollCount = 0;
    const listTaskPayloads = () => {
      if (!buildCalls.length) return [];
      if (cancelledRequested) {
        if (taskPollCount <= 2) {
          return [
            {
              id: "task-cancel-1",
              type: "knowledge_graph_build",
              status: "cancelling",
              progress: 48,
              message: "Cancelling knowledge graph build...",
              created_at: "2026-05-02T11:00:00.000Z",
              updated_at: "2026-05-02T11:00:05.000Z",
            },
          ];
        }
        return [
          {
            id: "task-cancel-1",
            type: "knowledge_graph_build",
            status: "cancelled",
            progress: 0,
            message: "Knowledge graph build cancelled",
            created_at: "2026-05-02T11:00:00.000Z",
            updated_at: "2026-05-02T11:00:10.000Z",
            result: null,
          },
        ];
      }
      if (taskPollCount === 0) {
        return [
          {
            id: "task-cancel-1",
            type: "knowledge_graph_build",
            status: "pending",
            progress: 0,
            message: "Queued",
            created_at: "2026-05-02T11:00:00.000Z",
            updated_at: "2026-05-02T11:00:00.000Z",
          },
        ];
      }
      return [
        {
          id: "task-cancel-1",
          type: "knowledge_graph_build",
          status: "running",
          progress: 48,
          message: "Running knowledge graph build...",
          created_at: "2026-05-02T11:00:00.000Z",
          updated_at: "2026-05-02T11:00:05.000Z",
        },
      ];
    };

    const dom = new JSDOM(renderGraphHtml({ mode: "page" }), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "http://127.0.0.1/",
      beforeParse(window) {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, Math.min(Number(ms) || 0, 5), ...args);
        window.confirm = () => true;
        window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
        window.cancelAnimationFrame = (id) => window.clearTimeout(id);
        window.fetch = async (url, init = {}) => {
          const href = String(url);
          const method = String(init.method || "GET").toUpperCase();
          const parsed = new URL(href, "http://127.0.0.1");
          const path = parsed.pathname.replace("/api/plugins/knowledge-graph", "");

          if (path === "/status") {
            return { ok: true, json: async () => status };
          }

          if (path === "/archives" && method === "GET") {
            return { ok: true, json: async () => ({ archives: [] }) };
          }

          if (path === "/data" && method === "GET") {
            return { ok: true, json: async () => JSON.parse(JSON.stringify(currentGraph)) };
          }

          if (path === "/build" && method === "POST") {
            const body = JSON.parse(init.body || "{}");
            buildCalls.push(body);
            taskPollCount = 0;
            cancelledRequested = false;
            status = makeStatus({
              graph: currentGraph,
              isBuilding: true,
              progress: 0,
              taskId: "task-cancel-1",
              taskStatus: "pending",
              archiveCount: 0,
            });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                task: {
                  id: "task-cancel-1",
                  type: "knowledge_graph_build",
                  status: "pending",
                  progress: 0,
                  message: "Queued",
                },
                status,
              }),
            };
          }

          if (path === "/tasks" && method === "GET") {
            const limit = Number(parsed.searchParams.get("limit") || 20) || 20;
            return {
              ok: true,
              json: async () => ({
                tasks: listTaskPayloads().slice(0, limit),
              }),
            };
          }

          if (path === "/tasks/task-cancel-1/cancel" && method === "POST") {
            cancelCalls.push("task-cancel-1");
            cancelledRequested = true;
            status = makeStatus({
              graph: currentGraph,
              isBuilding: true,
              progress: 48,
              taskId: "task-cancel-1",
              taskStatus: "cancelling",
              archiveCount: 0,
            });
            return {
              ok: true,
              json: async () => ({
                ok: true,
                reason: "cancelled",
                task: {
                  id: "task-cancel-1",
                  type: "knowledge_graph_build",
                  status: "cancelling",
                  progress: 48,
                  message: "Cancelling knowledge graph build...",
                },
              }),
            };
          }

          if (path === "/tasks/task-cancel-1" && method === "GET") {
            taskPollCount += 1;
            if (!cancelledRequested) {
              status = makeStatus({
                graph: currentGraph,
                isBuilding: true,
                progress: 48,
                taskId: "task-cancel-1",
                taskStatus: "running",
                archiveCount: 0,
              });
              return {
                ok: true,
                json: async () => ({
                  id: "task-cancel-1",
                  type: "knowledge_graph_build",
                  status: "running",
                  progress: 48,
                  message: "Running knowledge graph build...",
                }),
              };
            }

            if (taskPollCount <= 2) {
              status = makeStatus({
                graph: currentGraph,
                isBuilding: true,
                progress: 48,
                taskId: "task-cancel-1",
                taskStatus: "cancelling",
                archiveCount: 0,
              });
              return {
                ok: true,
                json: async () => ({
                  id: "task-cancel-1",
                  type: "knowledge_graph_build",
                  status: "cancelling",
                  progress: 48,
                  message: "Cancelling knowledge graph build...",
                }),
              };
            }

            status = makeStatus({
              graph: currentGraph,
              isBuilding: false,
              progress: 0,
              taskId: null,
              archiveCount: 0,
            });
            return {
              ok: true,
              json: async () => ({
                id: "task-cancel-1",
                type: "knowledge_graph_build",
                status: "cancelled",
                progress: 0,
                message: "Knowledge graph build cancelled",
                result: null,
              }),
            };
          }

          throw new Error(`unexpected fetch: ${method} ${path}`);
        };
      },
    });

    try {
      const textarea = await waitFor(() => dom.window.document.querySelector("#buildText"));
      const buildButton = dom.window.document.querySelector("#build");
      const cancelButton = dom.window.document.querySelector("#cancelBuild");
      const buildMsg = dom.window.document.querySelector("#buildMsg");

      textarea.value = "Alpha relates to Beta";
      buildButton.click();

      await waitFor(() => buildCalls.length === 1 && buildButton.disabled === false && cancelButton.disabled === false);

      cancelButton.click();
      await waitFor(() => cancelCalls.length === 1);
      await waitFor(() => buildMsg.textContent.includes("取消"));
      await waitFor(() => buildButton.disabled === false && cancelButton.disabled === true);
      await waitFor(() => status.is_building === false && status.current_task_id === null && taskPollCount > 2);

      expect(status).toEqual(
        expect.objectContaining({
          is_building: false,
          current_task_id: null,
        }),
      );
      expect(dom.window.document.querySelectorAll(".node")).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });
});
