// @ts-nocheck
import { AfterSalesStore } from "./store.ts";
import { parseAfterSalesMessage, shouldMonitorMessage } from "./message-parser.ts";
import { buildAfterSalesPrompt, buildAfterSalesReply } from "./prompt-builder.ts";
import { submitAfterSalesTask } from "./design-platform-client.ts";

export class AfterSalesService {
  constructor({ dataDir, logger = null }) {
    this.store = new AfterSalesStore(dataDir);
    this.logger = logger;
  }

  getConfig() {
    return this.store.getConfig();
  }

  updateConfig(patch) {
    const next = this.store.saveConfig(patch);
    this.logger?.log?.("aftersales", `config updated: ${Object.keys(patch || {}).join(",")}`);
    return next;
  }

  getStatus() {
    const tasks = this.store.listTasks({ limit: 1000 });
    const counts = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
    return {
      enabled: !!this.getConfig().enabled,
      taskCount: tasks.length,
      counts,
    };
  }

  listTasks(query = {}) {
    return this.store.listTasks(query);
  }

  getTask(id) {
    return this.store.getTask(id);
  }

  parseMessage(payload) {
    return parseAfterSalesMessage(payload?.text || "", this.getConfig());
  }

  shouldHandleBridgeMessage(payload) {
    const config = this.getConfig();
    if (!shouldMonitorMessage(payload, config)) return false;
    const parsed = parseAfterSalesMessage(payload?.text || "", config);
    return parsed.recognized;
  }

  createTaskFromMessage(payload) {
    const parsed = this.parseMessage(payload);
    const task = this.store.createTask({
      status: parsed.recognized ? "parsed" : "draft",
      source: {
        platform: payload?.platform || "wechat",
        groupName: payload?.groupName || "",
        senderName: payload?.senderName || "",
        sessionKey: payload?.sessionKey || "",
        messageId: payload?.messageId || "",
        rawText: payload?.text || "",
      },
      caseInfo: parsed.parsedCase,
      feedback: {
        parser: {
          confidence: parsed.confidence,
          missingFields: parsed.missingFields,
          recognized: parsed.recognized,
        },
      },
    });
    this.store.appendHistory(task.id, "message_ingested", {
      recognized: parsed.recognized,
      confidence: parsed.confidence,
    });
    return { task, parsed };
  }

  createTask(payload) {
    const task = this.store.createTask({
      status: "parsed",
      source: {
        platform: payload?.source?.platform || "manual",
        groupName: payload?.source?.groupName || "",
        senderName: payload?.source?.senderName || "",
        sessionKey: payload?.source?.sessionKey || "",
        messageId: payload?.source?.messageId || "",
        rawText: payload?.source?.rawText || "",
      },
      caseInfo: {
        productName: payload?.caseInfo?.productName || "",
        scene: payload?.caseInfo?.scene || "",
        style: payload?.caseInfo?.style || "",
        size: payload?.caseInfo?.size || this.getConfig().defaults.size,
        rounds: payload?.caseInfo?.rounds || this.getConfig().defaults.rounds,
        negativePrompt: payload?.caseInfo?.negativePrompt || this.getConfig().defaults.negativePrompt,
        expectations: payload?.caseInfo?.expectations || "",
        notes: payload?.caseInfo?.notes || "",
        rawPrompt: payload?.caseInfo?.rawPrompt || "",
      },
    });
    this.store.appendHistory(task.id, "task_created", { manual: true });
    return task;
  }

  async runTask(id) {
    const current = this.store.getTask(id);
    if (!current) throw new Error(`task not found: ${id}`);

    const promptBundle = buildAfterSalesPrompt(current, this.getConfig());
    this.store.updateTask(id, {
      status: "running",
      promptBundle,
      execution: {
        status: "running",
        mode: this.getConfig().designPlatform.mode,
      },
    });
    this.store.appendHistory(id, "task_running", { mode: this.getConfig().designPlatform.mode });

    const latest = this.store.getTask(id);
    const result = await submitAfterSalesTask(latest, this.getConfig());
    const nextStatus = result.ok ? "success" : "failed";
    const feedbackText = buildAfterSalesReply({
      ...latest,
      execution: result,
    });

    const updated = this.store.updateTask(id, {
      status: nextStatus,
      execution: {
        ...result,
        completedAt: new Date().toISOString(),
      },
      feedback: {
        ...(latest.feedback || {}),
        replyText: feedbackText,
      },
    });
    this.store.appendHistory(id, "task_finished", { status: nextStatus, mode: result.mode });
    this.logger?.log?.("aftersales", `task ${id} ${nextStatus} (${result.mode})`);
    return updated;
  }
}
