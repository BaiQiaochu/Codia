// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "company-state.json";

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function normalizeState(value) {
  return {
    companies: Array.isArray(value?.companies) ? value.companies : [],
    channels: Array.isArray(value?.channels) ? value.channels : [],
    tasks: Array.isArray(value?.tasks) ? value.tasks : [],
  };
}

export class CompanyStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, STATE_FILE);
    this._queue = Promise.resolve();
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _read() {
    return normalizeState(readJson(this.statePath, {}));
  }

  _write(state) {
    atomicWriteJson(this.statePath, normalizeState(state));
  }

  _withWriteLock(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async listCompanies() {
    return this._read().companies;
  }

  async getCompany(companyId) {
    return this._read().companies.find((company) => company.id === companyId) || null;
  }

  async upsertCompany(company) {
    return this._withWriteLock(async () => {
      const state = this._read();
      const index = state.companies.findIndex((item) => item.id === company.id);
      if (index >= 0) state.companies[index] = company;
      else state.companies.push(company);
      this._write(state);
      return company;
    });
  }

  async listChannels(companyId) {
    return this._read().channels.filter((channel) => !companyId || channel.companyId === companyId);
  }

  async getChannel(channelId) {
    return this._read().channels.find((channel) => channel.id === channelId) || null;
  }

  async findChannelByExternal(platform, externalGroupId) {
    return this._read().channels.find((channel) =>
      channel.platform === platform && channel.externalGroupId === externalGroupId) || null;
  }

  async upsertChannel(channel) {
    return this._withWriteLock(async () => {
      const state = this._read();
      const index = state.channels.findIndex((item) => item.id === channel.id);
      if (index >= 0) state.channels[index] = channel;
      else state.channels.push(channel);
      this._write(state);
      return channel;
    });
  }

  async updateChannel(channelId, patch) {
    return this._withWriteLock(async () => {
      const state = this._read();
      const index = state.channels.findIndex((item) => item.id === channelId);
      if (index < 0) return null;
      const previous = state.channels[index];
      const next = {
        ...previous,
        ...patch,
        id: previous.id,
        companyId: previous.companyId,
        truth: patch?.truth && typeof patch.truth === "object" ? patch.truth : previous.truth,
        updatedAt: new Date().toISOString(),
      };
      state.channels[index] = next;
      this._write(state);
      return next;
    });
  }

  async appendChannelMessage(channelId, message) {
    return this._withWriteLock(async () => {
      const state = this._read();
      const index = state.channels.findIndex((item) => item.id === channelId);
      if (index < 0) return null;
      const channel = state.channels[index];
      const truth = {
        messages: [],
        ...(channel.truth && typeof channel.truth === "object" ? channel.truth : {}),
      };
      truth.messages = [...(Array.isArray(truth.messages) ? truth.messages : []), message];
      const next = { ...channel, truth, updatedAt: message.createdAt };
      state.channels[index] = next;
      this._write(state);
      return next;
    });
  }

  async listTasks(companyId) {
    return this._read().tasks.filter((task) => !companyId || task.companyId === companyId);
  }

  async addTasks(tasks, validateExisting = null) {
    return this._withWriteLock(async () => {
      const state = this._read();
      if (validateExisting) validateExisting(state.tasks);
      state.tasks.push(...tasks);
      this._write(state);
      return tasks;
    });
  }

  async clearTasks({ companyId, channelIds } = {}) {
    return this._withWriteLock(async () => {
      const state = this._read();
      const channelSet = new Set(
        (Array.isArray(channelIds) ? channelIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      );
      const removed = [];
      const kept = [];
      for (const task of state.tasks) {
        const companyMatches = !companyId || task.companyId === companyId;
        const channelMatches = channelSet.size === 0 || channelSet.has(String(task.channelId || ""));
        if (companyMatches && channelMatches) removed.push(task);
        else kept.push(task);
      }
      state.tasks = kept;
      this._write(state);
      return { removedCount: removed.length, tasks: removed };
    });
  }

  async updateTask(taskId, patch) {
    return this._withWriteLock(async () => {
      const state = this._read();
      const index = state.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) return null;
      const previous = state.tasks[index];
      const changes = typeof patch === "function" ? patch(structuredClone(previous)) : patch;
      const now = new Date().toISOString();
      // Only observed status transitions establish execution boundaries. A report
      // edit cannot forge timestamps or retrofit legacy unknown execution dates.
      const terminal = new Set(["completed", "failed", "cancelled"]);
      const nextStatus = changes.status ?? previous.status;
      const startedAt = previous.startedAt || (nextStatus === "in_progress" && previous.status !== "in_progress" ? now : null);
      const finishedAt = previous.finishedAt || (terminal.has(nextStatus) && !terminal.has(previous.status) ? now : null);
      const fields = ["report", "artifacts", "acceptanceCriteria", "acceptanceResults"];
      const changed = fields.some(key => Object.hasOwn(changes, key) && JSON.stringify(changes[key]) !== JSON.stringify(previous[key]));
      const next = { ...previous, ...changes, id: previous.id, companyId: previous.companyId,
        startedAt, finishedAt, updatedAt: now,
        deliveryRevision: (previous.deliveryRevision || 0) + (changed ? 1 : 0),
      };
      state.tasks[index] = next;
      this._write(state);
      return next;
    });
  }
}

export function createCompanyStore(dataDir) {
  return new CompanyStore(dataDir);
}
