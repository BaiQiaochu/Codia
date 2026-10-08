// @ts-nocheck
import crypto from "node:crypto";
import { routeError, strictJson } from "../../../server/hono-helpers.ts";

const MAX_BUILD_TEXT = 120_000;

function storeUnavailable(c) {
  return c.json({ error: "知识图谱存储未初始化" }, 503);
}

function tasksUnavailable(c) {
  return c.json({ error: "知识图谱任务管理器未初始化" }, 503);
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function archiveIdFromQuery(c) {
  return String(c.req.query("archiveId") || c.req.query("archive") || "").trim();
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (typeof message.body === "string") return message.body;

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function collectBuildText(body) {
  const parts = [
    asString(body?.text),
    asString(body?.sessionText),
    asString(body?.sourceText),
    asString(body?.prompt),
  ];

  if (Array.isArray(body?.messages)) {
    parts.push(body.messages.map(messageText).filter(Boolean).join("\n"));
  }

  if (Array.isArray(body?.notes)) {
    parts.push(body.notes.map(messageText).filter(Boolean).join("\n"));
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function collectBuildDocuments(body) {
  if (!Array.isArray(body?.documents)) return [];

  return body.documents
    .map((document, index) => {
      if (typeof document === "string") {
        const text = document.trim();
        if (!text) return null;
        return {
          id: `doc-${index + 1}`,
          title: `文档 ${index + 1}`,
          text,
        };
      }

      if (!document || typeof document !== "object") return null;
      const text = String(document.text ?? document.content ?? document.body ?? "").trim();
      if (!text) return null;
      return {
        id: String(document.id ?? document.sourceId ?? document.source_id ?? "").trim() || undefined,
        title: String(document.title ?? document.name ?? `文档 ${index + 1}`).trim(),
        text,
      };
    })
    .filter(Boolean);
}

function totalDocumentLength(documents) {
  return documents.reduce((sum, item) => sum + String(item?.text || "").length, 0);
}

function makeSourceId(title, text) {
  return crypto
    .createHash("sha1")
    .update(`${title || ""}\n${String(text || "").slice(0, 4096)}`)
    .digest("hex")
    .slice(0, 12);
}

export default function registerGraphRoutes(app, ctx) {
  const store = () => ctx._knowledgeGraph?.store;
  const tasks = () => ctx._knowledgeGraph?.taskManager;

  app.get("/status", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const taskManager = tasks();
    const taskState = taskManager ? taskManager.getTaskState() : {};
    return c.json(instance.status(taskState));
  });

  app.get("/stats", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const archiveId = archiveIdFromQuery(c);
    const stats = instance.getStats({ archiveId });
    if (archiveId && !stats) return c.json({ error: "知识图谱归档不存在" }, 404);
    return c.json(stats);
  });

  app.get("/data", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const archiveId = archiveIdFromQuery(c);
    const data = instance.getData({ archiveId });
    if (archiveId && !data) return c.json({ error: "知识图谱归档不存在" }, 404);
    return c.json(data);
  });

  app.delete("/data", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    instance.clear();
    instance.flushSync();
    return c.json({
      ok: true,
      message: "当前知识图谱已清空",
      graph: instance.getData(),
      archives: instance.listArchives(),
    });
  });

  app.get("/archives", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    return c.json({
      archives: instance.listArchives(),
    });
  });

  app.get("/archives/:id", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const archive = instance.getArchive(c.req.param("id"));
    if (!archive) return c.json({ error: "知识图谱归档不存在" }, 404);
    return c.json({
      archive,
      graph: instance.getData({ archiveId: archive.id }),
    });
  });

  app.post("/archives/current", async (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);

    let body = {};
    try {
      body = await strictJson(c);
    } catch (error) {
      if (String(error?.message || "").includes("invalid JSON body")) {
        return routeError(c, error);
      }
    }

    const archived = instance.archiveCurrentGraph({
      title: String(body?.title || "").trim(),
      reason: String(body?.reason || "").trim() || "manual",
      source: "manual",
    });
    if (!archived) return c.json({ error: "当前没有可归档的知识图谱" }, 400);
    return c.json({
      ok: true,
      archive: archived,
      archives: instance.listArchives(),
    });
  });

  app.post("/archives/:id/restore", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const restored = instance.restoreArchive(c.req.param("id"));
    if (!restored) return c.json({ error: "知识图谱归档不存在" }, 404);
    instance.flushSync();
    return c.json({
      ok: true,
      archive: restored.archive,
      backup_archive: restored.backup_archive,
      graph: restored.graph,
      stats: restored.stats,
      archives: instance.listArchives(),
    });
  });

  app.delete("/archives/:id", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const deleted = instance.deleteArchive(c.req.param("id"));
    if (!deleted) return c.json({ error: "知识图谱归档不存在" }, 404);
    return c.json({
      ok: true,
      archives: instance.listArchives(),
    });
  });

  app.get("/tasks", (c) => {
    const taskManager = tasks();
    if (!taskManager) return tasksUnavailable(c);
    const limit = c.req.query("limit");
    const taskType = c.req.query("task_type") || c.req.query("taskType") || "";
    return c.json({
      tasks: taskManager.listTasks({
        limit: limit ? Number(limit) : 20,
        taskType,
      }),
    });
  });

  app.get("/tasks/:id", (c) => {
    const taskManager = tasks();
    if (!taskManager) return tasksUnavailable(c);
    const task = taskManager.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "任务不存在" }, 404);
    return c.json(task);
  });

  app.post("/tasks/:id/cancel", async (c) => {
    const taskManager = tasks();
    if (!taskManager) return tasksUnavailable(c);

    const taskId = String(c.req.param("id") || "").trim();
    const existingTask = taskManager.getTask(taskId);
    if (!existingTask) {
      return c.json({ error: "task not found" }, 404);
    }

    let cancelResult = null;
    if (typeof ctx.bus?.hasHandler === "function" && ctx.bus.hasHandler("task:abort")) {
      try {
        const busResponse = await ctx.bus.request("task:abort", { taskId });
        cancelResult = {
          ok: busResponse?.result === "aborted" || busResponse?.result === "already_aborted",
          reason: busResponse?.result || "unknown",
        };
      } catch {
        cancelResult = null;
      }
    }

    if (!cancelResult || cancelResult.reason === "no_handler" || cancelResult.reason === "not_found") {
      cancelResult = taskManager.cancelTask(taskId);
    }

    return c.json({
      ok: Boolean(cancelResult?.ok),
      reason: cancelResult?.reason || "unknown",
      task: taskManager.getTask(taskId),
    });
  });

  app.post("/tasks/cancel-all", async (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const taskManager = tasks();
    if (!taskManager) return tasksUnavailable(c);

    let body = {};
    try {
      body = await strictJson(c);
    } catch (error) {
      if (String(error?.message || "").includes("invalid JSON body")) {
        return routeError(c, error);
      }
    }

    const result = taskManager.cancelAllTasks({
      parentSessionPath: String(body?.parentSessionPath || body?.sessionPath || "").trim(),
    });

    return c.json({
      ok: Boolean(result?.ok),
      reason: result?.reason || "unknown",
      cancelled_count: Number(result?.count || 0),
      task_ids: Array.isArray(result?.taskIds) ? result.taskIds : [],
      tasks: Array.isArray(result?.tasks) ? result.tasks : [],
      status: instance.status(taskManager.getTaskState()),
    });
  });

  app.get("/nodes", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const archiveId = archiveIdFromQuery(c);
    const nodes = instance.listNodes({ archiveId });
    if (archiveId && !instance.getArchive(archiveId)) return c.json({ error: "知识图谱归档不存在" }, 404);
    return c.json(nodes);
  });

  app.get("/edges", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const archiveId = archiveIdFromQuery(c);
    const edges = instance.listEdges({ archiveId });
    if (archiveId && !instance.getArchive(archiveId)) return c.json({ error: "知识图谱归档不存在" }, 404);
    return c.json(edges);
  });

  app.get("/nodes/:id/sources", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const archiveId = archiveIdFromQuery(c);
    if (archiveId && !instance.getArchive(archiveId)) {
      return c.json({ error: "知识图谱归档不存在" }, 404);
    }
    const result = instance.getNodeSourceDocuments(c.req.param("id"), { archiveId });
    if (!result) return c.json({ error: "节点不存在" }, 404);
    return c.json(result);
  });

  app.delete("/nodes/:id", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    if (archiveIdFromQuery(c)) {
      return c.json({ error: "归档视图为只读，请先恢复到当前图谱后再编辑" }, 400);
    }
    const deleted = instance.deleteNode(c.req.param("id"));
    if (!deleted) return c.json({ error: "节点不存在" }, 404);
    instance.flushSync();
    return c.json({ ok: true });
  });

  app.delete("/edges/:id", (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    if (archiveIdFromQuery(c)) {
      return c.json({ error: "归档视图为只读，请先恢复到当前图谱后再编辑" }, 400);
    }
    const deleted = instance.deleteEdge(c.req.param("id"));
    if (!deleted) return c.json({ error: "关系不存在" }, 404);
    instance.flushSync();
    return c.json({ ok: true });
  });

  app.post("/build", async (c) => {
    const instance = store();
    if (!instance) return storeUnavailable(c);
    const taskManager = tasks();
    if (!taskManager) return tasksUnavailable(c);

    let body;
    try {
      body = await strictJson(c);
    } catch (error) {
      return routeError(c, error);
    }

    const documents = collectBuildDocuments(body);
    const text = collectBuildText(body);
    const title = String(body?.title || "").trim();
    const maxNodes = body?.maxNodes;
    const rebuild = Boolean(body?.rebuild);

    if (documents.length === 0 && !text) {
      return c.json({ error: "请提供要构建知识图谱的文本内容" }, 400);
    }

    const totalLength = documents.length > 0 ? totalDocumentLength(documents) : text.length;
    if (totalLength > MAX_BUILD_TEXT) {
      return c.json({ error: `文本过大，最多支持 ${MAX_BUILD_TEXT} 个字符` }, 413);
    }

    const submission = taskManager.submitBuildTask({
      title,
      text,
      documents,
      rebuild,
      maxNodes,
      sourceId: String(body?.sourceId || "").trim() || makeSourceId(title, text),
      archiveTitle: String(body?.archiveTitle || "").trim(),
      archiveReason: String(body?.archiveReason || "").trim() || "rebuild",
      parentSessionPath: String(body?.parentSessionPath || body?.sessionPath || "").trim(),
    });

    if (!submission.accepted) {
      return c.json({ error: "知识图谱构建任务提交失败" }, 400);
    }

    return c.json(
      {
        ok: true,
        queued: Boolean(submission.queued),
        reason: submission.reason || null,
        replaced_task_ids: Array.isArray(submission.replacedTaskIds) ? submission.replacedTaskIds : [],
        task: submission.task,
        status: instance.status(taskManager.getTaskState()),
      },
      202,
    );
  });
}