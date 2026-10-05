// @ts-nocheck
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function createDefaultAfterSalesConfig() {
  return {
    version: 1,
    enabled: false,
    wechat: {
      enabled: false,
      autoCreateTask: true,
      autoRunTask: true,
      autoReply: true,
      ackMessage: "已收到测试案例，正在提交设计聚焦平台执行生图测试。",
      monitoredGroups: [],
      includeKeywords: ["测试", "生图", "案例", "出图", "图测"],
      excludeKeywords: ["闲聊", "广告"],
    },
    designPlatform: {
      mode: "dry-run",
      submitUrl: "",
      submitMethod: "POST",
      apiKey: "",
      apiKeyHeader: "Authorization",
      apiKeyPrefix: "Bearer ",
      workflowId: "",
      timeoutMs: 120000,
      extraHeaders: {},
      extraBody: {},
      taskIdPath: "taskId",
      imageUrlsPath: "images",
      statusPath: "status",
      successValues: ["success", "completed", "done"],
      errorPath: "error.message",
      polling: {
        enabled: false,
        statusUrlTemplate: "",
        method: "GET",
        intervalMs: 5000,
        maxAttempts: 24,
      },
    },
    promptTemplate: {
      systemRole:
        "你是产品售后分身，负责将客户测试需求整理成稳定、专业、可执行的测试摘要。",
      checklist: [
        "尺寸是否正确",
        "主体是否完整",
        "风格是否符合要求",
        "是否存在明显畸形或错误元素",
        "是否满足测试目标",
      ],
    },
    defaults: {
      size: "1024x1024",
      style: "",
      rounds: 1,
      negativePrompt: "",
    },
  };
}

function createDefaultTaskFile() {
  return { version: 1, tasks: [] };
}

export class AfterSalesStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, "config.json");
    this.tasksPath = path.join(dataDir, "tasks.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this._ensureFiles();
  }

  _ensureFiles() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.configPath)) {
      atomicWriteSync(this.configPath, JSON.stringify(createDefaultAfterSalesConfig(), null, 2) + "\n");
    }
    if (!fs.existsSync(this.tasksPath)) {
      atomicWriteSync(this.tasksPath, JSON.stringify(createDefaultTaskFile(), null, 2) + "\n");
    }
  }

  _readJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return fallback;
    }
  }

  getConfig() {
    this._ensureFiles();
    const raw = this._readJson(this.configPath, createDefaultAfterSalesConfig());
    return deepMerge(createDefaultAfterSalesConfig(), raw);
  }

  saveConfig(patch) {
    this._ensureFiles();
    const next = deepMerge(this.getConfig(), patch || {});
    atomicWriteSync(this.configPath, JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  _readTasksFile() {
    this._ensureFiles();
    return this._readJson(this.tasksPath, createDefaultTaskFile());
  }

  _writeTasksFile(payload) {
    this._ensureFiles();
    atomicWriteSync(this.tasksPath, JSON.stringify(payload, null, 2) + "\n");
  }

  listTasks({ status, limit = 100 } = {}) {
    const file = this._readTasksFile();
    let tasks = [...(file.tasks || [])];
    if (status) tasks = tasks.filter((task) => task.status === status);
    tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return tasks.slice(0, limit);
  }

  getTask(id) {
    const file = this._readTasksFile();
    return (file.tasks || []).find((task) => task.id === id) || null;
  }

  createTask(partial) {
    const file = this._readTasksFile();
    const now = new Date().toISOString();
    const task = {
      id: partial.id || `aft_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      source: {
        platform: "wechat",
        groupName: "",
        senderName: "",
        sessionKey: "",
        messageId: "",
        rawText: "",
      },
      caseInfo: {
        productName: "",
        scene: "",
        style: "",
        size: "",
        rounds: 1,
        negativePrompt: "",
        expectations: "",
        notes: "",
        rawPrompt: "",
      },
      promptBundle: null,
      execution: {
        status: "draft",
        mode: "dry-run",
        externalTaskId: null,
        imageUrls: [],
      },
      feedback: null,
      history: [],
      ...partial,
    };
    file.tasks = file.tasks || [];
    file.tasks.push(task);
    this._writeTasksFile(file);
    return task;
  }

  updateTask(id, patch) {
    const file = this._readTasksFile();
    const index = (file.tasks || []).findIndex((task) => task.id === id);
    if (index === -1) return null;
    const current = file.tasks[index];
    const next = deepMerge(current, patch || {});
    next.updatedAt = new Date().toISOString();
    file.tasks[index] = next;
    this._writeTasksFile(file);
    return next;
  }

  appendHistory(id, type, detail = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    const history = Array.isArray(task.history) ? [...task.history] : [];
    history.push({
      at: new Date().toISOString(),
      type,
      detail,
    });
    return this.updateTask(id, { history });
  }
}
