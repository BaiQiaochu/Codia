#!/usr/bin/env node
// @ts-nocheck
import fs from "node:fs";
import { commandUsage } from "./usage-maintenance.ts";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { stdin as input, stdout as output, stderr } from "node:process";
import WebSocket from "ws";
import { resolveModelInputModalities } from "../../shared/model-capabilities.ts";
import { DEFAULT_TIMEOUT_MS, parseGlobalArgs } from "./args.ts";
import { readBridgeStatusSafe, formatBridgeCliSummary } from "./bridge-status.ts";
import { dispatchCliCommand, normalizeCommandName } from "./commands.ts";
import { CodiaClient, parseOptionalJson, wsConnect } from "./client.ts";
import { CliError } from "./errors.ts";
import { parseJson } from "./json.ts";
import { readImages } from "./media.ts";
import {
  formatPermissionMode,
  permissionModeFromCodexRuntimeOptions,
  readPermissionMode,
  setPermissionMode,
} from "./permission-mode.ts";
import {
  createColorPalette,
  drawCliCardToString,
  fitText,
  padRight,
  printJson as writeJson,
  textWidth,
} from "./render.ts";
import { repoRoot } from "./runtime-paths.ts";
import { ensureServerInfo, spawnServerForeground } from "./server.ts";

const INTERACTIVE_TIMEOUT_MS = 30 * 60_000;

let useColor = output.isTTY && !process.env.NO_COLOR;
let color = createColorPalette(useColor);

function paint(name, text) {
  if (!useColor) return String(text);
  return `${color[name] || ""}${text}${color.reset}`;
}

function setColorEnabled(enabled) {
  useColor = enabled;
  color = createColorPalette(useColor);
}

let cachedPackageVersion = null;

function packageVersion() {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf8"));
    cachedPackageVersion = pkg.version || "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

function displayPath(filePath, maxWidth = 42) {
  const resolved = path.resolve(filePath || process.cwd());
  const home = path.resolve(os.homedir());
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedHome = process.platform === "win32" ? home.toLowerCase() : home;
  const shown = normalized === normalizedHome
    ? "~"
    : normalized.startsWith(normalizedHome + path.sep)
      ? `~${path.sep}${path.relative(home, resolved)}`
      : resolved;
  return fitText(shown, maxWidth);
}

function sessionName(sessionPath) {
  if (!sessionPath) return "自动选择";
  return fitText(path.basename(sessionPath).replace(/\.(jsonl|json)$/i, ""), 36);
}

function drawCliCard(lines, width = 58) {
  output.write(drawCliCardToString(lines, width));
}

function truncate(value, max = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function formatDate(value) {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return time.toLocaleString("zh-CN", { hour12: false });
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseConfigValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {}
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return value;
}

function getPathValue(source, dottedPath) {
  if (!dottedPath) return source;
  const parts = String(dottedPath).split(".").filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current == null || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function objectFromPath(dottedPath, value) {
  const parts = String(dottedPath || "").split(".").filter(Boolean);
  if (!parts.length) throw new CliError("config set 需要配置键");
  const root = {};
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
  return root;
}

function redactConfigSecrets(value, key = "") {
  const secretPattern = /(api[_-]?key|token|secret|password|cookie|authorization|credential)/i;
  if (secretPattern.test(key)) {
    if (value === undefined || value === null || value === "") return value;
    return "********";
  }
  if (Array.isArray(value)) return value.map((item) => redactConfigSecrets(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactConfigSecrets(childValue, childKey)]),
    );
  }
  return value;
}

function takeOption(args, names, fallback = null) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const index = args.indexOf(name);
    if (index < 0) continue;
    if (index === args.length - 1) throw new CliError(`${name} 需要参数`);
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  }
  return fallback;
}

function takeFlag(args, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const index = args.indexOf(name);
    if (index < 0) continue;
    args.splice(index, 1);
    return true;
  }
  return false;
}

function takeRepeated(args, names) {
  const list = Array.isArray(names) ? names : [names];
  const values = [];
  for (;;) {
    let found = -1;
    for (const name of list) {
      found = args.indexOf(name);
      if (found >= 0) break;
    }
    if (found < 0) break;
    if (found === args.length - 1) throw new CliError(`${args[found]} 需要参数`);
    values.push(args[found + 1]);
    args.splice(found, 2);
  }
  return values;
}

function encodeQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : "";
}

async function readStdinText() {
  return new Promise((resolve, reject) => {
    let text = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => { text += chunk; });
    input.on("end", () => resolve(text));
    input.on("error", reject);
  });
}

class WsRunner {
  constructor(client, { sessionPath = null } = {}) {
    this.client = client;
    this.sessionPath = sessionPath;
    this.ws = null;
    this.pending = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = await wsConnect(this.client);
    this.connected = true;
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", () => {
      this.connected = false;
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(new CliError("WebSocket 已断开", { code: 6 }));
      }
    });
    this.ws.on("error", (error) => {
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(new CliError(`WebSocket 错误: ${error.message}`, { code: 6 }));
      }
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    try { ws?.close(); } catch {}
    try { ws?.terminate?.(); } catch {}
  }

  abort() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "abort", sessionPath: this.sessionPath }));
  }

  async run(payload, options = {}) {
    await this.connect();
    if (this.pending) throw new CliError("当前会话仍在响应中，请等待完成或执行 /stop");
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abort();
        this.pending = null;
        reject(new CliError("等待回复超时", { code: 5 }));
      }, timeoutMs);
      this.pending = {
        resolve,
        reject,
        timer,
        text: "",
        stream: options.stream !== false,
        capture: options.capture !== false,
        mode: options.mode || "prompt",
        showedHeader: false,
        thinking: false,
      };
      this.ws.send(JSON.stringify(payload));
    });
  }

  finish(result = {}) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ text: pending.text, ...result });
  }

  fail(message, details = null) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new CliError(message, { code: 6, details }));
  }

  shouldIgnore(msg) {
    if (!msg?.sessionPath || !this.sessionPath) return false;
    return msg.sessionPath !== this.sessionPath;
  }

  handleMessage(data) {
    const msg = parseOptionalJson(data.toString());
    if (!msg || this.shouldIgnore(msg)) return;
    const pending = this.pending;
    if (!pending) return;

    switch (msg.type) {
      case "text_delta": {
        const delta = msg.delta || "";
        pending.text += delta;
        if (pending.stream) output.write(delta);
        break;
      }
      case "thinking_start":
        pending.thinking = true;
        if (pending.stream) output.write(paint("dim", "\n[思考中]\n"));
        break;
      case "thinking_end":
        pending.thinking = false;
        break;
      case "tool_start":
        if (pending.stream) {
          const args = msg.args && Object.keys(msg.args).length ? ` ${JSON.stringify(msg.args)}` : "";
          output.write(paint("dim", `\n[工具] ${msg.name || "unknown"}${args}\n`));
        }
        break;
      case "tool_end":
        if (pending.stream) {
          const label = msg.success === false ? "工具失败" : "工具完成";
          output.write(paint(msg.success === false ? "yellow" : "dim", `[${label}] ${msg.name || ""}\n`));
        }
        break;
      case "content_block":
        if (pending.stream) printContentBlockSummary(msg.block);
        break;
      case "slash_result":
        if (pending.stream && msg.text) output.write(`${msg.text}\n`);
        pending.text += msg.text || "";
        this.finish({ type: "slash_result" });
        break;
      case "compaction_end":
        if (pending.stream) output.write(paint("green", "会话压缩完成。\n"));
        this.finish({ type: "compaction_end", summary: msg.summary || null });
        break;
      case "turn_end":
        if (pending.stream) output.write("\n");
        this.finish({ type: "turn_end" });
        break;
      case "error":
        this.fail(msg.message || "WebSocket 返回错误", msg);
        break;
      default:
        break;
    }
  }
}

function printContentBlockSummary(block) {
  if (!block || typeof block !== "object") return;
  if (block.type === "session_file" || block.type === "artifact") {
    const label = block.title || block.label || block.fileName || block.path || block.filePath || block.type;
    output.write(paint("dim", `[内容] ${label}\n`));
  }
}

async function createClient(opts) {
  const info = await ensureServerInfo(opts);
  return new CodiaClient(info, opts);
}

async function getCurrentAgentId(client) {
  const data = await client.get("/agents");
  const agents = data.agents || [];
  const current = agents.find((agent) => agent.isCurrent) || agents.find((agent) => agent.isPrimary) || agents[0];
  return current?.id || "";
}

async function getSessionByRef(client, ref) {
  const sessions = await client.get("/sessions");
  return (sessions || []).find((session) => session.path === ref || session.id === ref) || null;
}

async function ensureSession(client, args = [], { create = false } = {}) {
  const sessionPathArg = takeOption(args, ["--session", "--path"]);
  const sessionIdArg = takeOption(args, "--session-id");
  const cwd = takeOption(args, "--cwd", process.cwd());
  const agentId = takeOption(args, "--agent-id");
  const forceNew = create || takeFlag(args, "--new");

  if (sessionPathArg) return sessionPathArg;
  if (sessionIdArg) {
    const found = await getSessionByRef(client, sessionIdArg);
    if (!found?.path) throw new CliError(`找不到会话 ${sessionIdArg}`, { code: 4 });
    return found.path;
  }
  if (forceNew) {
    const created = await client.post("/sessions/new", { cwd, agentId: agentId || undefined });
    if (!created?.path) throw new CliError(created?.error || "新建会话失败", { code: 4 });
    return created.path;
  }

  const sessions = await client.get("/sessions");
  if (Array.isArray(sessions) && sessions[0]?.path) return sessions[0].path;

  const created = await client.post("/sessions/new", { cwd, agentId: agentId || undefined });
  if (!created?.path) throw new CliError(created?.error || "没有可用会话，自动创建失败", { code: 4 });
  return created.path;
}

async function applyCodexRuntimeOptions(client, opts = {}, { sessionPath = null } = {}) {
  const permissionMode = permissionModeFromCodexRuntimeOptions({
    approvalMode: opts.approvalMode,
    sandboxMode: opts.sandboxMode,
  });
  if (!permissionMode) return null;
  const data = await setPermissionMode(client, permissionMode, { sessionPath });
  return data.permissionMode || data.mode || permissionMode;
}

function printJson(data) {
  writeJson(output, data);
}

function printTable(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => String(column.value(row) ?? "").length),
  ));
  output.write(columns.map((column, i) => column.label.padEnd(widths[i])).join("  ") + "\n");
  output.write(columns.map((_, i) => "-".repeat(widths[i])).join("  ") + "\n");
  for (const row of rows) {
    output.write(columns.map((column, i) => String(column.value(row) ?? "").padEnd(widths[i])).join("  ") + "\n");
  }
}

function formatModelInput(model) {
  return resolveModelInputModalities(model).join(",");
}

async function commandHealth(client, opts) {
  const health = await client.get("/health");
  const bridge = await readBridgeStatusSafe(client);
  if (opts.json) return printJson({ ok: true, baseUrl: client.baseUrl, ...health, bridge });
  output.write(`${paint("green", "连接正常")} ${paint("dim", client.baseUrl)}\n`);
  output.write(`助手: ${health.agent || "-"}\n`);
  output.write(`用户: ${health.user || "-"}\n`);
  output.write(`模型: ${health.model || "未设置"}\n`);
  output.write(`Bridge: ${formatBridgeCliSummary(bridge)}\n`);
}

async function commandDoctor(client, _args, opts) {
  const checks = [];
  const check = async (name, run) => {
    try {
      const data = await run();
      checks.push({ name, ok: true });
      return data;
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
      return null;
    }
  };

  const health = await check("health", () => client.get("/health"));
  const bridge = await check("bridge", () => client.get("/bridge/status"));
  const permissions = await check("permissions", () => readPermissionMode(client));
  const sessions = await check("sessions", () => client.get("/sessions"));
  const report = {
    ok: checks.every((item) => item.ok),
    version: packageVersion(),
    baseUrl: client.baseUrl,
    health,
    bridge,
    permissionMode: permissions?.permissionMode || permissions?.mode || null,
    sessionCount: Array.isArray(sessions) ? sessions.length : null,
    checks,
  };

  if (opts.json) return printJson(report);
  output.write(`${paint(report.ok ? "green" : "yellow", report.ok ? "检查通过" : "部分检查失败")} ${paint("dim", client.baseUrl)}\n`);
  output.write(`版本: ${report.version}\n`);
  output.write(`权限: ${report.permissionMode ? formatPermissionMode(report.permissionMode) : "-"}\n`);
  output.write(`会话: ${report.sessionCount ?? "-"}\n`);
  for (const item of checks) {
    output.write(`${item.ok ? "ok" : "!!"} ${item.name}${item.error ? ` - ${item.error}` : ""}\n`);
  }
  return report;
}

async function commandServe(_client, args, opts) {
  const child = spawnServerForeground(opts, args);
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code && code !== 0) {
        reject(new CliError(`Codia server 异常退出，退出码 ${code}`, { code }));
        return;
      }
      if (signal) {
        reject(new CliError(`Codia server 被 ${signal} 终止`, { code: 1 }));
        return;
      }
      resolve();
    });
  });
}

async function commandChat(client, args, opts) {
  const originalArgs = [...args];
  const stdinMode = takeFlag(args, "--stdin");
  const stream = takeFlag(args, "--stream") || (!opts.json && !takeFlag(args, "--no-stream"));
  const imagePaths = takeRepeated(args, ["--image", "--img"]);
  const promptArgs = [...args];
  takeOption(promptArgs, ["--session", "--path"]);
  takeOption(promptArgs, "--session-id");
  takeOption(promptArgs, "--cwd");
  takeOption(promptArgs, "--agent-id");
  takeFlag(promptArgs, "--new");
  const text = stdinMode ? (await readStdinText()).trim() : promptArgs.join(" ").trim();
  if (!stdinMode && !text && !imagePaths.length) {
    return await commandInteractive(client, originalArgs, opts);
  }
  const sessionPath = await ensureSession(client, args);
  await applyCodexRuntimeOptions(client, opts, { sessionPath });
  if (!text && !imagePaths.length) throw new CliError("chat 需要文本、--stdin 或 --image");
  const runner = new WsRunner(client, { sessionPath });
  const images = await readImages(imagePaths);
  const result = await runner.run(
    { type: "prompt", text, images, sessionPath, displayMessage: text },
    { stream, capture: true, timeoutMs: opts.timeoutMs },
  );
  runner.close();
  const response = { ok: true, sessionPath, text: result.text, stream };
  if (opts.json && !opts.silent) printJson(response);
  else if (!stream && !opts.silent) output.write(`${result.text}\n`);
  return response;
}

export function writeLastMessageFile(filePath, text) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, String(text || ""), "utf8");
  return resolved;
}

async function commandExec(client, args, opts) {
  const outputLastMessage = takeOption(args, ["--output-last-message", "--output", "-o"]);
  const dryRun = takeFlag(args, "--dry-run");
  const noTools = takeFlag(args, "--no-tools");
  const hasStreamChoice = args.includes("--stream") || args.includes("--no-stream");
  if (!hasStreamChoice) args.unshift("--no-stream");
  if (dryRun || noTools) {
    const guard = [
      dryRun ? "Dry-run mode: only analyze, plan, and explain. Do not modify files or execute shell commands." : "",
      noTools ? "No-tools mode: answer without calling tools." : "",
    ].filter(Boolean).join(" ");
    args.unshift(`[CLI ${dryRun ? "dry-run" : "guard"}] ${guard}`);
  }

  const runtimeOpts = dryRun
    ? { ...opts, silent: true, sandboxMode: opts.sandboxMode || "read-only", approvalMode: opts.approvalMode || "on-request" }
    : { ...opts, silent: true };
  const result = await commandChat(client, args, runtimeOpts);
  const outputPath = outputLastMessage ? writeLastMessageFile(outputLastMessage, result.text) : null;

  if (opts.json) {
    printJson({ ...result, dryRun, noTools, outputLastMessage: outputPath || undefined });
  } else {
    if (!result.stream) output.write(`${result.text}\n`);
    if (outputPath) output.write(`${paint("dim", `[输出文件] ${outputPath}`)}\n`);
  }

  return { ...result, dryRun, noTools, outputLastMessage: outputPath };
}

async function commandSessions(client, args, opts) {
  const sub = args.shift() || "list";
  if (sub === "list" || sub === "ls") {
    const sessions = await client.get("/sessions");
    if (opts.json) return printJson(sessions);
    if (!sessions.length) return output.write("暂无会话。\n");
    printTable(sessions.slice(0, 50), [
      { label: "ID", value: (s) => s.id || "" },
      { label: "助手", value: (s) => truncate(s.agentName || s.agentId || "-", 16) },
      { label: "模型", value: (s) => truncate(s.modelId || "-", 24) },
      { label: "更新时间", value: (s) => formatDate(s.modified) },
      { label: "标题", value: (s) => truncate(s.title || s.firstMessage || "未命名", 42) },
    ]);
    return;
  }
  if (sub === "new") {
    const cwd = takeOption(args, "--cwd", process.cwd());
    const agentId = takeOption(args, "--agent-id");
    const data = await client.post("/sessions/new", { cwd, agentId: agentId || undefined });
    if (opts.json) return printJson(data);
    output.write(`${paint("green", "已新建会话")} ${data.id || ""}\n${data.path || ""}\n`);
    return;
  }
  if (sub === "switch" || sub === "use") {
    const ref = takeOption(args, ["--session", "--session-id"]) || args.shift();
    if (!ref) throw new CliError("sessions switch 需要 id 或 path");
    const found = await getSessionByRef(client, ref);
    const data = await client.post("/sessions/switch", { sessionPath: found?.path || ref });
    if (opts.json) return printJson(data);
    output.write(`${paint("green", "已切换到")} ${found?.id || ref}\n`);
    return;
  }
  if (sub === "messages" || sub === "msg") {
    const limit = Number(takeOption(args, "--limit", args[0] || 20)) || 20;
    const sessionPath = await ensureSession(client, args);
    const data = await client.get(`/sessions/messages${encodeQuery({ path: sessionPath, limit })}`);
    if (opts.json) return printJson(data);
    for (const message of data.messages || []) {
      const role = message.role === "user" ? "用户" : "助手";
      output.write(`\n${paint(message.role === "user" ? "cyan" : "green", role)}\n${message.content || ""}\n`);
    }
    return;
  }
  if (sub === "export") {
    const sessionPath = await ensureSession(client, args);
    const data = await client.get(`/sessions/export${encodeQuery({ path: sessionPath })}`);
    printJson(data);
    return;
  }
  throw new CliError(`未知 sessions 子命令 ${sub}`);
}

async function commandModels(client, args, opts) {
  const sub = args.shift() || "list";
  if (sub === "list" || sub === "ls") {
    const data = await client.get("/models");
    if (opts.json) return printJson(data);
    const active = data.activeModel;
    const rows = (data.models || []).map((model) => ({
      ...model,
      active: active?.id === model.id && active?.provider === model.provider,
    }));
    if (!rows.length) return output.write("没有可用模型。请先在设置中添加 provider 和模型。\n");
    printTable(rows, [
      { label: "当前", value: (m) => (m.active || m.isCurrent ? "*" : "") },
      { label: "Provider", value: (m) => m.provider },
      { label: "模型", value: (m) => truncate(m.id, 44) },
      { label: "名称", value: (m) => truncate(m.name || "", 32) },
      { label: "输入", value: formatModelInput },
    ]);
    return;
  }
  if (sub === "set" || sub === "default") {
    const provider = takeOption(args, "--provider") || args.shift();
    const modelId = takeOption(args, ["--model", "--model-id"]) || args.join(" ").trim();
    if (!provider || !modelId) throw new CliError("models set 需要 provider 和 modelId");
    const data = await client.post("/models/set", { provider, modelId });
    if (opts.json) return printJson(data);
    output.write(`${paint("green", "已设置默认模型")} ${provider}/${modelId}\n`);
    return;
  }
  if (sub === "switch") {
    const provider = takeOption(args, "--provider") || args.shift();
    const modelId = takeOption(args, ["--model", "--model-id"]) || args.shift();
    const sessionPath = await ensureSession(client, args);
    if (!provider || !modelId) throw new CliError("models switch 需要 provider 和 modelId");
    const data = await client.post("/models/switch", { provider, modelId, sessionPath });
    if (opts.json) return printJson(data);
    output.write(`${paint("green", "已切换当前会话模型")} ${provider}/${modelId}\n`);
    return;
  }
  throw new CliError(`未知 models 子命令 ${sub}`);
}

async function commandAgents(client, args, opts) {
  const sub = args.shift() || "list";
  if (sub === "list" || sub === "ls") {
    const data = await client.get("/agents");
    if (opts.json) return printJson(data);
    const agents = data.agents || [];
    if (!agents.length) return output.write("暂无智能体。\n");
    printTable(agents, [
      { label: "当前", value: (a) => (a.isCurrent ? "*" : "") },
      { label: "ID", value: (a) => a.id },
      { label: "名称", value: (a) => truncate(a.name || a.agentName || "", 24) },
      { label: "描述", value: (a) => truncate(a.description || "", 48) },
    ]);
    return;
  }
  if (sub === "switch" || sub === "use") {
    const id = takeOption(args, "--id") || args.shift();
    if (!id) throw new CliError("agents switch 需要 id");
    const data = await client.post("/agents/switch", { id });
    if (opts.json) return printJson(data);
    output.write(`${paint("green", "已切换智能体")} ${data.agent?.name || id}\n`);
    return;
  }
  if (sub === "create") {
    const id = takeOption(args, "--id");
    const yuan = takeOption(args, "--yuan");
    const name = takeOption(args, "--name", args.join(" ").trim());
    if (!name) throw new CliError("agents create requires --name or name text");
    const data = await client.post("/agents", { id: id || undefined, yuan: yuan || undefined, name });
    if (opts.json) return printJson(data);
    output.write(`${paint("green", "已创建智能体")} ${data.name || name} (${data.id || id || ""})\n`);
    return;
  }
  throw new CliError(`未知 agents 子命令 ${sub}`);
}

async function commandSkills(client, args, opts) {
  const agentId = takeOption(args, "--agent-id", args[0] || await getCurrentAgentId(client));
  if (!agentId) throw new CliError("skills requires agentId, but no agent is currently available");
  const runtime = takeFlag(args, "--runtime") ? "1" : "";
  const data = await client.get(`/skills${encodeQuery({ agentId, runtime })}`);
  if (opts.json) return printJson(data);
  const skills = data.skills || [];
  if (!skills.length) return output.write("当前智能体没有可用技能。\n");
  printTable(skills, [
    { label: "启用", value: (s) => (s.enabled === false ? "" : "*") },
    { label: "名称", value: (s) => s.name || "" },
    { label: "说明", value: (s) => truncate(s.description || "", 60) },
  ]);
}

async function commandCommands(client, args, opts) {
  const data = await client.get("/commands");
  if (opts.json) return printJson(data);
  const commands = data.commands || [];
  if (!commands.length) return output.write("没有可用 slash 命令。\n");
  printTable(commands, [
    { label: "命令", value: (cmd) => `/${cmd.name}` },
    { label: "权限", value: (cmd) => cmd.permission || "" },
    { label: "来源", value: (cmd) => cmd.source || "" },
    { label: "说明", value: (cmd) => truncate(cmd.description || "", 60) },
  ]);
}

async function commandConfig(client, args, opts) {
  const sub = (args.shift() || "list").toLowerCase();
  if (sub === "list" || sub === "ls" || sub === "show") {
    const data = redactConfigSecrets(await client.get("/config"));
    if (opts.json) return printJson(data);
    output.write(`${JSON.stringify(data, null, 2)}\n`);
    return data;
  }

  if (sub === "get") {
    const key = args.shift();
    if (!key) throw new CliError("用法: codia config get <key>");
    const data = redactConfigSecrets(await client.get("/config"));
    const value = getPathValue(data, key);
    if (value === undefined) throw new CliError(`配置不存在: ${key}`, { code: 4 });
    if (opts.json) return printJson({ key, value });
    output.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  if (sub === "set") {
    const key = args.shift();
    if (!key || !args.length) throw new CliError("用法: codia config set <key> <value>");
    const value = parseConfigValue(args.join(" "));
    const patch = objectFromPath(key, value);
    const result = await client.put("/config", patch);
    if (opts.json) return printJson({ ok: true, key, value: redactConfigSecrets(value, key), result });
    output.write(`${paint("green", "已更新配置")} ${key}\n`);
    return result;
  }

  throw new CliError(`未知 config 子命令: ${sub}`);
}

async function commandPermissions(client, args, opts) {
  const sessionPath = takeOption(args, ["--session", "--path"]);
  let action = (args.shift() || "get").toLowerCase();
  if (["readonly", "read-only", "read_only", "ro", "ask", "prompt", "operate", "auto", "full"].includes(action)) {
    args.unshift(action);
    action = "set";
  }

  if (action === "get") {
    const data = await readPermissionMode(client, { sessionPath });
    if (opts.json) return printJson({ ok: true, ...data });
    output.write(`权限模式: ${formatPermissionMode(data.permissionMode || data.mode)}\n`);
    return data;
  }

  if (action === "set") {
    const mode = args.shift();
    if (!mode) throw new CliError("用法: codiactl permissions set <read_only|ask|operate>");
    const data = await setPermissionMode(client, mode, { sessionPath });
    if (opts.json) return printJson({ ok: true, ...data });
    output.write(`${paint("green", "权限模式已更新")} ${formatPermissionMode(data.permissionMode || data.mode)}\n`);
    return data;
  }

  throw new CliError("用法: codiactl permissions get|set <read_only|ask|operate>");
}

async function commandResume(client, args, opts) {
  const useLast = takeFlag(args, "--last");
  const ref = args.join(" ").trim();
  if (!ref && !useLast) return await commandSessions(client, ["list"], opts);
  if (ref && useLast) throw new CliError("resume accepts either --last or a session id/path, not both");
  const found = useLast ? (await client.get("/sessions"))?.[0] : await getSessionByRef(client, ref);
  const sessionPath = found?.path || ref;
  if (!sessionPath) throw new CliError("resume --last could not find a previous session", { code: 4 });
  const data = await client.post("/sessions/switch", { sessionPath });
  const session = found || data?.session || { path: sessionPath, id: ref };
  if (opts.json) return printJson({ ok: true, session });
  output.write(`${paint("green", "已恢复到")} ${session.id || session.path}\n`);
  return session;
}

async function resumeInteractiveSession(client, state, runner, ref) {
  if (!ref) {
    output.write("用法: /resume <session-id|path>\n");
    return;
  }
  const found = await getSessionByRef(client, ref);
  await client.post("/sessions/switch", { sessionPath: found?.path || ref, currentSessionPath: state.sessionPath || undefined });
  state.sessionPath = found?.path || ref;
  runner.sessionPath = state.sessionPath;
  output.write(`${paint("green", "已恢复到")} ${found?.id || ref}\n`);
}

async function showOrSetInteractivePermissions(client, state, args) {
  const action = (args[0] || "get").toLowerCase();
  if (action === "get" && args.length <= 1) {
    const data = await readPermissionMode(client, { sessionPath: state.sessionPath });
    output.write(`权限模式: ${formatPermissionMode(data.permissionMode || data.mode)}\n`);
    return;
  }
  const mode = action === "set" ? args[1] : args[0];
  if (!mode) {
    output.write("用法: /permissions [read_only|ask|operate]\n");
    return;
  }
  const data = await setPermissionMode(client, mode, { sessionPath: state.sessionPath });
  output.write(`${paint("green", "权限模式已更新")} ${formatPermissionMode(data.permissionMode || data.mode)}\n`);
}

async function commandFs(client, args, opts) {
  const sub = args.shift() || "read";
  if (sub !== "read" && sub !== "cat") throw new CliError(`未知 fs 子命令 ${sub}`);
  const filePath = args.join(" ").trim();
  if (!filePath) throw new CliError("fs read 需要文件路径");
  const text = await client.get(`/fs/read${encodeQuery({ path: filePath })}`, { text: true });
  if (opts.json) printJson({ ok: true, path: filePath, content: text });
  else output.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function commandRaw(client, args, opts) {
  const method = (args.shift() || "GET").toUpperCase();
  const apiPath = args.shift();
  if (!apiPath) throw new CliError("raw 需要 METHOD API path");
  let body;
  const bodyText = takeOption(args, "--body");
  if (bodyText !== null) body = parseJson(bodyText, "--body");
  if (takeFlag(args, "--stdin")) body = parseJson(await readStdinText(), "stdin");
  const data = await client.request(method, apiPath, { body });
  if (opts.json || typeof data === "object") printJson(data);
  else output.write(`${data}\n`);
}

function _helpText() {
  return zhHelpText();
}

async function selectFromList(rl, title, items, render) {
  output.write(`\n${paint("bold", title)}\n`);
  items.forEach((item, index) => output.write(`  ${index + 1}. ${render(item, index)}\n`));
  output.write(`  q. 取消\n`);
  const answer = (await rl.question(paint("cyan", "选择 > "))).trim();
  if (!answer || answer.toLowerCase() === "q") return null;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    output.write(paint("yellow", "选择无效。\n"));
    return null;
  }
  return items[index];
}

async function showStatus(client, state) {
  const health = await client.get("/health");
  const bridge = await readBridgeStatusSafe(client);
  output.write(`\n${paint("bold", "当前状态")}\n`);
  output.write(`后端: ${client.baseUrl}\n`);
  output.write(`助手: ${health.agent || "-"}\n`);
  output.write(`用户: ${health.user || "-"}\n`);
  output.write(`模型: ${health.model || "未设置"}\n`);
  output.write(`会话: ${state.sessionPath || "-"}\n`);
  output.write(`Bridge: ${formatBridgeCliSummary(bridge)}\n`);
}

async function chooseSession(client, rl, state) {
  const sessions = await client.get("/sessions");
  if (!sessions.length) {
    output.write("暂无会话。\n");
    return;
  }
  const selected = await selectFromList(
    rl,
    "选择会话",
    sessions.slice(0, 30),
    (s) => `${s.id || ""}  ${truncate(s.title || s.firstMessage || "未命名", 48)}  ${paint("dim", s.agentName || s.agentId || "")}`,
  );
  if (!selected) return;
  await client.post("/sessions/switch", { sessionPath: selected.path, currentSessionPath: state.sessionPath || undefined });
  state.sessionPath = selected.path;
  output.write(`${paint("green", "已切换到")} ${selected.id}\n`);
}

async function chooseModel(client, rl, state) {
  const data = await client.get("/models");
  const models = data.models || [];
  if (!models.length) {
    output.write("没有可用模型。请先在设置中添加 provider。\n");
    return;
  }
  const selected = await selectFromList(
    rl,
    "选择模型",
    models,
    (m) => `${m.provider}/${m.id}${m.isCurrent ? paint("green", "  当前") : ""}  ${paint("dim", m.name || "")}`,
  );
  if (!selected) return;
  const sessionPath = state.sessionPath || await ensureSession(client, []);
  await client.post("/models/switch", { sessionPath, provider: selected.provider, modelId: selected.id });
  state.sessionPath = sessionPath;
  output.write(`${paint("green", "已切换模型")} ${selected.provider}/${selected.id}\n`);
}

async function chooseAgent(client, rl, state) {
  const data = await client.get("/agents");
  const agents = data.agents || [];
  if (!agents.length) {
    output.write("暂无智能体。\n");
    return;
  }
  const selected = await selectFromList(
    rl,
    "选择智能体",
    agents,
    (a) => `${a.id}  ${a.name || a.agentName || ""}${a.isCurrent ? paint("green", "  当前") : ""}`,
  );
  if (!selected) return;
  await client.post("/agents/switch", { id: selected.id });
  const created = await client.post("/sessions/new", { cwd: process.cwd(), agentId: selected.id, currentSessionPath: state.sessionPath || undefined });
  state.sessionPath = created.path || state.sessionPath;
  output.write(`${paint("green", "已切换智能体并新建会话")} ${selected.name || selected.id}\n`);
}

async function listRecentMessages(client, state, limit = 10) {
  const sessionPath = state.sessionPath || await ensureSession(client, []);
  const data = await client.get(`/sessions/messages${encodeQuery({ path: sessionPath, limit })}`);
  for (const message of data.messages || []) {
    const role = message.role === "user" ? "用户" : "助手";
    output.write(`\n${paint(message.role === "user" ? "cyan" : "green", role)}\n${message.content || ""}\n`);
  }
}

async function showInteractiveHelp() {
  output.write(`\n${paint("bold", "可用命令")}\n`);
  output.write(`/menu                 打开本地菜单\n`);
  output.write(`/status               查看后端、会话和模型状态\n`);
  output.write(`/new                  新建并切换会话\n`);
  output.write(`/session              打开会话选择器\n`);
  output.write(`/resume <id|path>     恢复指定会话\n`);
  output.write(`/permissions [mode]   查看或切换权限模式\n`);
  output.write(`/model                打开模型选择器\n`);
  output.write(`/agent                打开智能体选择器\n`);
  output.write(`/messages [数量]      查看最近消息\n`);
  output.write(`/skills               列出当前智能体技能\n`);
  output.write(`/commands             列出可用 slash 命令\n`);
  output.write(`/image <路径> [文本]  发送本地图片\n`);
  output.write(`/compact              压缩当前会话上下文\n`);
  output.write(`/stop                 中断当前回复\n`);
  output.write(`/exit                 退出 CLI\n`);
  output.write(`其他未识别的 /命令 会转发到后端 slash dispatcher。\n`);
}

async function showMainMenu(client, rl, state, runner) {
  output.write(`\n${paint("bold", "Codia 菜单")}\n`);
  output.write(`  1. 新建会话\n`);
  output.write(`  2. 切换会话\n`);
  output.write(`  3. 切换模型\n`);
  output.write(`  4. 切换智能体\n`);
  output.write(`  5. 查看最近消息\n`);
  output.write(`  6. 列出技能\n`);
  output.write(`  7. 列出 slash 命令\n`);
  output.write(`  8. 查看状态\n`);
  output.write(`  9. 压缩当前会话\n`);
  output.write(`  0. 取消\n`);
  const answer = (await rl.question(paint("cyan", "选择 > "))).trim();
  if (answer === "1") {
    const created = await client.post("/sessions/new", { cwd: process.cwd(), currentSessionPath: state.sessionPath || undefined });
    state.sessionPath = created.path || state.sessionPath;
    runner.sessionPath = state.sessionPath;
    output.write(`${paint("green", "已新建会话")} ${created.id || ""}\n`);
  } else if (answer === "2") await chooseSession(client, rl, state);
  else if (answer === "3") await chooseModel(client, rl, state);
  else if (answer === "4") await chooseAgent(client, rl, state);
  else if (answer === "5") await listRecentMessages(client, state, 10);
  else if (answer === "6") await commandSkills(client, [], { json: false });
  else if (answer === "7") await commandCommands(client, [], { json: false });
  else if (answer === "8") await showStatus(client, state);
  else if (answer === "9") await runner.run({ type: "compact", sessionPath: state.sessionPath }, { mode: "compact", stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
  runner.sessionPath = state.sessionPath;
}

function _introCard(client, state) {
  output.write(`${paint("bold", "Codia CLI")}\n`);
  output.write(`${paint("dim", "Interactive terminal that talks directly to the Codia server")}\n`);
  output.write(`后端: ${client.baseUrl}\n`);
  output.write(`目录: ${process.cwd()}\n`);
  output.write(`会话: ${state.sessionPath || "自动选择"}\n`);
  output.write(`${paint("dim", "Type /menu for actions, /help for commands, or /exit to quit")}\n\n`);
}

function zhHelpText() {
  return `Codia 中文 CLI

用法:
  codia --help
  codia --version
  codia serve [--port <port>]
  codia chat [--new] [--session <path>]
  codia run [--new] [--stdin] [--image <path>] <文本>
  codia run [--output <file>] [--no-stream] [--dry-run] [--no-tools] <文本>
  codia resume <session-id|path>
  codia resume --last
  codia permissions get|set <read_only|ask|operate>
  codia config list
  codia config get <key>
  codia config set <key> <value>
  codia doctor [--json]
  codia health [--json]
  codia session list|new|switch|messages|export
  codia usage report
  codia usage budget [set <JSON>]
  codia usage retention <agentId> [set <JSON> | apply --confirm]
  codia models list|set|switch
  codia agents list|switch|create
  codia skills [--agent-id <id>]
  codia commands
  codia fs read <path>
  codia raw <METHOD> <api-path> [--body JSON|--stdin]

命令别名:
  codiactl、codia、codia-cli 与 codia 使用同一套 CLI runtime。

连接参数:
  --home <dir>          指定 CODIA_HOME
  --server-info <file>  指定 server-info 文件，默认 server-info.cli.json
  --api-base <url>      连接外部后端，例如 http://127.0.0.1:50150
  --host <host>         默认 127.0.0.1
  --port <port>         配合 --token 直连端口，也可作为 serve 启动端口
  --token <token>       指定 token
  --no-start-server     找不到服务时不自动启动
  --json                输出 JSON
  --approval-mode <mode> Codex 审批: untrusted|on-request|on-failure|never
  --sandbox <mode>       Codex 沙盒: read-only|workspace-write|danger-full-access
`;
}

function zhPrompt(state) {
  const status = `codia · ${displayPath(process.cwd(), 48)} · ${sessionName(state.sessionPath)}`;
  return `${paint("dim", status)}\n${paint("cyan", "")} `;
}

async function readHealthSafe(client) {
  try {
    return await client.get("/health");
  } catch {
    return {};
  }
}

async function showZhIntro(client, state) {
  const health = await readHealthSafe(client);
  drawCliCard([
    `>_ Codia CLI (v${packageVersion()})`,
    "",
    `模型:     ${health.model || "未设置"}    /model 切换`,
    `助手:     ${health.agent || "-"}    /agent 切换`,
    `目录:     ${displayPath(process.cwd(), 40)}`,
    `会话:     ${sessionName(state.sessionPath)}`,
    `后端:     ${client.baseUrl}`,
  ]);
  output.write(`\n${paint("bold", "提示:")} 输入 /help 查看命令，/menu 打开菜单，/exit 退出。\n\n`);
}

async function showZhStatus(client, state) {
  const health = await readHealthSafe(client);
  const bridge = await readBridgeStatusSafe(client);
  output.write(`\n${paint("bold", "当前状态")}\n`);
  output.write(`后端:   ${client.baseUrl}\n`);
  output.write(`助手:   ${health.agent || "-"}\n`);
  output.write(`用户:   ${health.user || "-"}\n`);
  output.write(`模型:   ${health.model || "未设置"}\n`);
  output.write(`目录:   ${process.cwd()}\n`);
  output.write(`会话:   ${state.sessionPath || "自动选择"}\n`);
  output.write(`Bridge: ${formatBridgeCliSummary(bridge)}\n`);
}

async function zhSelectFromList(rl, title, items, render) {
  output.write(`\n${paint("bold", title)}\n`);
  items.forEach((item, index) => output.write(`  ${index + 1}. ${render(item, index)}\n`));
  output.write("  q. 取消\n");
  const answer = (await rl.question(paint("cyan", "选择 > "))).trim();
  if (!answer || answer.toLowerCase() === "q") return null;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    output.write(paint("yellow", "选择无效。\n"));
    return null;
  }
  return items[index];
}

async function listZhSessions(client) {
  const sessions = await client.get("/sessions");
  if (!sessions.length) return output.write("暂无会话。\n");
  printTable(sessions.slice(0, 30), [
    { label: "ID", value: (s) => s.id || "" },
    { label: "标题", value: (s) => truncate(s.title || s.firstMessage || "未命名", 42) },
    { label: "助手", value: (s) => s.agentName || s.agentId || "" },
  ]);
}

async function chooseZhSession(client, rl, state) {
  const sessions = await client.get("/sessions");
  if (!sessions.length) return output.write("暂无会话。\n");
  const selected = await zhSelectFromList(
    rl,
    "选择会话",
    sessions.slice(0, 30),
    (s) => `${s.id || ""}  ${truncate(s.title || s.firstMessage || "未命名", 48)}  ${paint("dim", s.agentName || s.agentId || "")}`,
  );
  if (!selected) return;
  await client.post("/sessions/switch", { sessionPath: selected.path, currentSessionPath: state.sessionPath || undefined });
  state.sessionPath = selected.path;
  output.write(`${paint("green", "已切换到")} ${selected.id || selected.path}\n`);
}

async function listZhModels(client) {
  const data = await client.get("/models");
  const models = data.models || [];
  if (!models.length) return output.write("没有可用模型。请先在设置中添加 provider。\n");
  printTable(models, [
    { label: "当前", value: (m) => (m.isCurrent ? "*" : "") },
    { label: "Provider", value: (m) => m.provider || "" },
    { label: "模型", value: (m) => m.id || "" },
    { label: "名称", value: (m) => truncate(m.name || "", 36) },
    { label: "输入", value: formatModelInput },
  ]);
}

function zhModelRef(model) {
  return [model.provider, model.id].filter(Boolean).join("/");
}

function zhModelCandidates(model) {
  return [
    zhModelRef(model),
    model.id,
    model.name,
  ].filter(Boolean).map((value) => String(value));
}

function findZhModel(models, query) {
  const raw = String(query || "").trim();
  if (!raw) return { model: null, reason: "empty" };
  const byNumber = Number(raw);
  if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= models.length) {
    return { model: models[byNumber - 1], reason: "number" };
  }

  const normalized = raw.toLowerCase();
  const exact = models.filter((model) => zhModelCandidates(model).some((value) => value.toLowerCase() === normalized));
  if (exact.length === 1) return { model: exact[0], reason: "exact" };
  if (exact.length > 1) return { model: null, reason: "ambiguous", matches: exact };

  const prefix = models.filter((model) => zhModelCandidates(model).some((value) => value.toLowerCase().startsWith(normalized)));
  if (prefix.length === 1) return { model: prefix[0], reason: "prefix" };
  if (prefix.length > 1) return { model: null, reason: "ambiguous", matches: prefix };

  const fuzzy = models.filter((model) => zhModelCandidates(model).some((value) => value.toLowerCase().includes(normalized)));
  if (fuzzy.length === 1) return { model: fuzzy[0], reason: "fuzzy" };
  if (fuzzy.length > 1) return { model: null, reason: "ambiguous", matches: fuzzy };
  return { model: null, reason: "missing" };
}

function formatZhModelMatch(model, index = null) {
  const prefix = Number.isInteger(index) ? `${index + 1}. ` : "";
  const current = model.isCurrent ? paint("green", "  当前") : "";
  const label = model.name && model.name !== model.id ? `  ${paint("dim", model.name)}` : "";
  const inputModes = formatModelInput(model);
  const capability = inputModes ? `  ${paint("dim", inputModes)}` : "";
  return `${prefix}${zhModelRef(model)}${current}${label}${capability}`;
}

async function switchZhModel(client, state, model) {
  const sessionPath = state.sessionPath || await ensureSession(client, []);
  const data = await client.post("/models/switch", { sessionPath, provider: model.provider, modelId: model.id });
  state.sessionPath = sessionPath;
  const switched = data.model?.name || model.name || model.id;
  output.write(`${paint("green", "已切换模型")} ${model.provider}/${model.id} ${paint("dim", switched)}\n`);
  return data;
}

async function switchZhModelByQuery(client, state, query) {
  const data = await client.get("/models");
  const models = data.models || [];
  if (!models.length) {
    output.write("没有可用模型。请先在设置中添加 provider。\n");
    return false;
  }

  const found = findZhModel(models, query);
  if (found.model) {
    await switchZhModel(client, state, found.model);
    return true;
  }

  if (found.reason === "ambiguous") {
    output.write(`${paint("yellow", "匹配到多个模型，请输入更完整的名称或序号。")}\n`);
    (found.matches || []).slice(0, 12).forEach((model, index) => output.write(`  ${formatZhModelMatch(model, index)}\n`));
    return false;
  }

  output.write(`${paint("yellow", "没有找到匹配模型")} ${query}\n`);
  output.write("可用模型：\n");
  models.slice(0, 12).forEach((model, index) => output.write(`  ${formatZhModelMatch(model, index)}\n`));
  return false;
}

async function chooseZhModel(client, rl, state) {
  const data = await client.get("/models");
  const models = data.models || [];
  if (!models.length) return output.write("没有可用模型。请先在设置中添加 provider。\n");
  const selected = await zhSelectFromList(
    rl,
    "选择模型",
    models,
    (m) => `${m.provider}/${m.id}${m.isCurrent ? paint("green", "  当前") : ""}  ${paint("dim", m.name || "")}`,
  );
  if (!selected) return;
  await switchZhModel(client, state, selected);
}

async function listZhAgents(client) {
  const data = await client.get("/agents");
  const agents = data.agents || [];
  if (!agents.length) return output.write("暂无智能体。\n");
  printTable(agents, [
    { label: "当前", value: (a) => (a.isCurrent ? "*" : "") },
    { label: "ID", value: (a) => a.id || "" },
    { label: "名称", value: (a) => truncate(a.name || a.agentName || "", 24) },
    { label: "描述", value: (a) => truncate(a.description || "", 48) },
  ]);
}

async function chooseZhAgent(client, rl, state) {
  const data = await client.get("/agents");
  const agents = data.agents || [];
  if (!agents.length) return output.write("暂无智能体。\n");
  const selected = await zhSelectFromList(
    rl,
    "选择智能体",
    agents,
    (a) => `${a.id}  ${a.name || a.agentName || ""}${a.isCurrent ? paint("green", "  当前") : ""}`,
  );
  if (!selected) return;
  await client.post("/agents/switch", { id: selected.id });
  const created = await client.post("/sessions/new", { cwd: process.cwd(), agentId: selected.id, currentSessionPath: state.sessionPath || undefined });
  state.sessionPath = created.path || state.sessionPath;
  output.write(`${paint("green", "已切换智能体并新建会话")} ${selected.name || selected.id}\n`);
}

async function listZhRecentMessages(client, state, limit = 10) {
  const sessionPath = state.sessionPath || await ensureSession(client, []);
  const data = await client.get(`/sessions/messages${encodeQuery({ path: sessionPath, limit })}`);
  for (const message of data.messages || []) {
    const role = message.role === "user" ? "用户" : "助手";
    output.write(`\n${paint(message.role === "user" ? "cyan" : "green", role)}\n${message.content || ""}\n`);
  }
}

async function showZhSkills(client) {
  const agentId = await getCurrentAgentId(client);
  if (!agentId) return output.write("当前没有可用智能体。\n");
  const data = await client.get(`/skills${encodeQuery({ agentId })}`);
  const skills = data.skills || [];
  if (!skills.length) return output.write("当前智能体没有可用技能。\n");
  printTable(skills, [
    { label: "启用", value: (s) => (s.enabled === false ? "" : "*") },
    { label: "名称", value: (s) => s.name || "" },
    { label: "说明", value: (s) => truncate(s.description || "", 60) },
  ]);
}

async function showZhCommands(client) {
  const data = await client.get("/commands");
  const commands = data.commands || [];
  if (!commands.length) return output.write("没有可用 slash 命令。\n");
  printTable(commands, [
    { label: "命令", value: (cmd) => `/${cmd.name}` },
    { label: "权限", value: (cmd) => cmd.permission || "" },
    { label: "来源", value: (cmd) => cmd.source || "" },
    { label: "说明", value: (cmd) => truncate(cmd.description || "", 60) },
  ]);
}

async function showZhInteractiveHelp() {
  output.write(`\n${paint("bold", "可用命令")}\n`);
  output.write(`/menu                 打开本地菜单\n`);
  output.write(`/status               查看后端、会话和模型状态\n`);
  output.write(`/new                  新建并切换会话\n`);
  output.write(`/session              打开会话选择器\n`);
  output.write(`/sessions             列出所有会话\n`);
  output.write(`/use <id|path>        切换到指定会话\n`);
  output.write(`/resume <id|path>     恢复指定会话\n`);
  output.write(`/permissions [mode]   查看或切换权限模式\n`);
  output.write(`/model                打开模型选择器\n`);
  output.write(`/models               列出所有模型\n`);
  output.write(`/agent                打开智能体选择器\n`);
  output.write(`/agent <id>           切换智能体并新建会话\n`);
  output.write(`/agents               列出所有智能体\n`);
  output.write(`/skills               列出当前智能体技能\n`);
  output.write(`/commands             列出可用 slash 命令\n`);
  output.write(`/messages [数量]      查看当前会话最近消息\n`);
  output.write(`/image <路径> [文本]  发送本地图片\n`);
  output.write(`/compact              压缩当前会话上下文\n`);
  output.write(`/stop                 中断当前回复\n`);
  output.write(`/clear                清屏\n`);
  output.write(`/exit                 退出 CLI\n`);
  output.write(`其他未识别的 /命令 会转发到后端 slash dispatcher。\n`);
}

async function showZhMainMenu(client, rl, state, runner) {
  output.write(`\n${paint("bold", "Codia 菜单")}\n`);
  output.write(`  1. 新建会话\n`);
  output.write(`  2. 切换会话\n`);
  output.write(`  3. 切换模型\n`);
  output.write(`  4. 切换智能体\n`);
  output.write(`  5. 查看最近消息\n`);
  output.write(`  6. 列出技能\n`);
  output.write(`  7. 列出 slash 命令\n`);
  output.write(`  8. 查看状态\n`);
  output.write(`  9. 压缩当前会话\n`);
  output.write(`  0. 取消\n`);
  const answer = (await rl.question(paint("cyan", "选择 > "))).trim();
  if (answer === "1") {
    const created = await client.post("/sessions/new", { cwd: process.cwd(), currentSessionPath: state.sessionPath || undefined });
    state.sessionPath = created.path || state.sessionPath;
    runner.sessionPath = state.sessionPath;
    output.write(`${paint("green", "已新建会话")} ${created.id || ""}\n`);
  } else if (answer === "2") await chooseZhSession(client, rl, state);
  else if (answer === "3") await chooseZhModel(client, rl, state);
  else if (answer === "4") await chooseZhAgent(client, rl, state);
  else if (answer === "5") await listZhRecentMessages(client, state, 10);
  else if (answer === "6") await showZhSkills(client);
  else if (answer === "7") await showZhCommands(client);
  else if (answer === "8") await showZhStatus(client, state);
  else if (answer === "9") await runner.run({ type: "compact", sessionPath: state.sessionPath }, { mode: "compact", stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
  runner.sessionPath = state.sessionPath;
}

const ZH_INTERACTIVE_COMMANDS = [
  { command: "/help", description: "查看帮助信息" },
  { command: "/menu", description: "打开本地菜单" },
  { command: "/status", description: "查看后端、会话和模型状态" },
  { command: "/new", description: "新建并切换会话" },
  { command: "/session", description: "打开会话选择器" },
  { command: "/sessions", description: "列出所有会话" },
  { command: "/use", description: "切换到指定会话" },
  { command: "/resume", description: "恢复指定会话" },
  { command: "/permissions", description: "查看或切换权限模式" },
  { command: "/model", description: "选择或切换模型" },
  { command: "/models", description: "列出所有模型" },
  { command: "/agent", description: "选择或切换智能体" },
  { command: "/agents", description: "列出所有智能体" },
  { command: "/skills", description: "列出当前智能体技能" },
  { command: "/commands", description: "列出可用 slash 命令" },
  { command: "/messages", description: "查看当前会话最近消息" },
  { command: "/image", description: "发送本地图片" },
  { command: "/compact", description: "压缩当前会话上下文" },
  { command: "/stop", description: "中断当前回复" },
  { command: "/clear", description: "清屏" },
  { command: "/exit", description: "退出 CLI" },
];

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function createZhCompleter(getModelCache) {
  return (line) => {
    const text = String(line || "");
    if (!text.startsWith("/")) return [[], text];

    const modelPrefixMatch = text.match(/^\/model\s+(.+)$/i);
    if (modelPrefixMatch) {
      const rawPrefix = modelPrefixMatch[1] || "";
      const prefix = rawPrefix.toLowerCase();
      const models = getModelCache();
      const hits = uniqueStrings(models.flatMap((model) => [
        zhModelRef(model),
        model.id,
        model.name,
      ])).filter((candidate) => candidate.toLowerCase().startsWith(prefix));
      return [hits.length ? hits.map((hit) => `/model ${hit}`) : [], text];
    }

    if (/^\/model\s*$/i.test(text)) {
      const models = getModelCache();
      const hits = uniqueStrings(models.flatMap((model) => [zhModelRef(model), model.id]));
      return [hits.map((hit) => `/model ${hit}`), text];
    }

    const hits = ZH_INTERACTIVE_COMMANDS
      .map((item) => item.command)
      .filter((command) => command.startsWith(text));
    return [hits.length ? hits : ZH_INTERACTIVE_COMMANDS.map((item) => item.command), text];
  };
}

function buildZhCompletionMenu(line, modelCache = [], { maxItems = 10 } = {}) {
  const text = String(line || "").trim();
  if (!text.startsWith("/")) return { lines: [], hint: "" };

  if (/^\/model(?:\s+.*)?$/i.test(text)) {
    const query = text.replace(/^\/model\s*/i, "").trim().toLowerCase();
    const models = modelCache.filter((model) => !query || zhModelCandidates(model).some((value) => value.toLowerCase().includes(query)));
    const lines = [`${paint("bold", "/model")}${paint("dim", "  Select a model by number, model name, or provider/model")}`];
    if (models.length) {
      models.slice(0, maxItems).forEach((model, index) => lines.push(`  ${formatZhModelMatch(model, index)}`));
    } else {
      lines.push(`  ${paint("dim", "No local model match; press Enter to refresh from the server")}`);
    }
    return { lines, hint: lines.join("\n") };
  }

  const hits = ZH_INTERACTIVE_COMMANDS.filter((item) => item.command.startsWith(text));
  const entries = (hits.length ? hits : ZH_INTERACTIVE_COMMANDS).slice(0, maxItems);
  const lines = entries
    .map((item, index) => {
      const command = index === 0 ? paint("cyan", item.command) : item.command;
      const description = index === 0 ? paint("cyan", item.description) : paint("dim", item.description);
      return `${padRight(command, 16)} ${description}`;
    });
  return { lines, hint: lines.join("\n") };
}

function formatZhCompletionHint(line, modelCache = [], options = {}) {
  return buildZhCompletionMenu(line, modelCache, options).hint;
}

function showZhCompletionHint(line, modelCache = []) {
  const hint = formatZhCompletionHint(line, modelCache);
  if (!hint) return false;
  output.write(`\n${hint}\n`);
  return true;
}

function terminalLineRows(text, columns = output.columns || 80) {
  const width = textWidth(text);
  return Math.max(1, Math.ceil(Math.max(1, width) / Math.max(1, columns)));
}

function terminalRowsForLines(lines, columns = output.columns || 80) {
  return (lines || []).reduce((rows, line) => rows + terminalLineRows(line, columns), 0);
}

function createZhSlashHintRenderer(rl, getModelCache) {
  if (!input.isTTY || !output.isTTY) return null;

  let active = false;
  let currentPrompt = "";
  let lastHint = "";
  let lastBlockTopRow = null;
  let scheduled = null;

  function promptRows() {
    const columns = output.columns || 80;
    const promptLines = String(currentPrompt || "").split("\n");
    const beforeInput = promptLines.slice(0, -1).reduce((rows, line) => rows + terminalLineRows(line, columns), 0);
    const inputLine = `${promptLines[promptLines.length - 1] || ""}${rl.line || ""}`;
    return beforeInput + terminalLineRows(inputLine, columns);
  }

  function cursorRowsFromPromptTop() {
    const columns = output.columns || 80;
    const promptLines = String(currentPrompt || "").split("\n");
    const beforeInput = promptLines.slice(0, -1).reduce((rows, line) => rows + terminalLineRows(line, columns), 0);
    const cursor = Number.isInteger(rl.cursor) ? rl.cursor : String(rl.line || "").length;
    const inputPrefix = String(rl.line || "").slice(0, cursor);
    const inputLine = `${promptLines[promptLines.length - 1] || ""}${inputPrefix}`;
    return beforeInput + terminalLineRows(inputLine, columns) - 1;
  }

  function clearPreviousRegion() {
    if (lastBlockTopRow) {
      cursorTo(output, 0, lastBlockTopRow - 1);
      clearScreenDown(output);
      return;
    }
    const rowsUp = cursorRowsFromPromptTop();
    if (rowsUp > 0) moveCursor(output, 0, -rowsUp);
    cursorTo(output, 0);
    clearScreenDown(output);
  }

  function render(menu) {
    const columns = output.columns || 80;
    const hintRows = terminalRowsForLines(menu.lines, columns);
    const totalRows = Math.max(1, hintRows + promptRows());
    const blockTopRow = Math.max(1, (output.rows || 24) - totalRows + 1);
    clearPreviousRegion();
    cursorTo(output, 0, blockTopRow - 1);
    clearScreenDown(output);
    if (menu.hint) output.write(`${menu.hint}\n`);
    rl.prompt(true);

    lastBlockTopRow = blockTopRow;
  }

  function schedule() {
    if (!active || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      const line = String(rl.line || "");
      const menu = buildZhCompletionMenu(line, getModelCache(), { maxItems: 8 });
      if (!menu.hint && !lastBlockTopRow) return;
      if (menu.hint === lastHint && menu.hint) return;
      lastHint = menu.hint;
      render(menu);
    }, 0);
  }

  function clearFromCurrentLine(submittedLine = null) {
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    if (!lastBlockTopRow && !lastHint) return;
    if (lastBlockTopRow) {
      cursorTo(output, 0, lastBlockTopRow - 1);
      clearScreenDown(output);
      if (submittedLine !== null) output.write(`${currentPrompt}${submittedLine}\n`);
      lastBlockTopRow = null;
      lastHint = "";
      return;
    }
    lastHint = "";
    cursorTo(output, 0);
    clearScreenDown(output);
  }

  function onKeypress(_chunk, key = {}) {
    if (!active) return;
    if (key.name === "return" || key.name === "enter") return;
    schedule();
  }

  emitKeypressEvents(input, rl);
  input.on("keypress", onKeypress);

  return {
    activate(prompt) {
      active = true;
      currentPrompt = String(prompt || "");
      rl.setPrompt(currentPrompt);
    },
    deactivate(submittedLine = null) {
      active = false;
      clearFromCurrentLine(submittedLine);
    },
    close() {
      this.deactivate();
      input.off("keypress", onKeypress);
    },
  };
}

async function refreshZhModelCompletionCache(client, state) {
  try {
    const data = await client.get("/models");
    state.modelCache = data.models || [];
  } catch {
    state.modelCache = state.modelCache || [];
  }
}

async function handleZhInteractiveCommand(line, client, rl, state, runner) {
  const [rawCmd, ...rest] = line.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const args = rest.filter(Boolean);
  if (["exit", "quit", "q"].includes(cmd)) return false;
  if (cmd === "help" || cmd === "h") await showZhInteractiveHelp();
  else if (cmd === "menu") await showZhMainMenu(client, rl, state, runner);
  else if (cmd === "status") await showZhStatus(client, state);
  else if (cmd === "new") {
    const created = await client.post("/sessions/new", { cwd: process.cwd(), currentSessionPath: state.sessionPath || undefined });
    state.sessionPath = created.path || state.sessionPath;
    runner.sessionPath = state.sessionPath;
    output.write(`${paint("green", "已新建会话")} ${created.id || ""}\n`);
  } else if (cmd === "session") await chooseZhSession(client, rl, state);
  else if (cmd === "sessions") await listZhSessions(client);
  else if (cmd === "use") {
    const ref = args.join(" ").trim();
    if (!ref) output.write("用法: /use <session-id|path>\n");
    else {
      const found = await getSessionByRef(client, ref);
      await client.post("/sessions/switch", { sessionPath: found?.path || ref, currentSessionPath: state.sessionPath || undefined });
      state.sessionPath = found?.path || ref;
      runner.sessionPath = state.sessionPath;
      output.write(`${paint("green", "已切换到")} ${found?.id || ref}\n`);
    }
  } else if (cmd === "resume") await resumeInteractiveSession(client, state, runner, args.join(" ").trim());
  else if (cmd === "permissions") await showOrSetInteractivePermissions(client, state, args);
  else if (cmd === "model") {
    const query = args.join(" ").trim();
    if (query) await switchZhModelByQuery(client, state, query);
    else await chooseZhModel(client, rl, state);
  }
  else if (cmd === "models") await listZhModels(client);
  else if (cmd === "agent") {
    if (args[0]) {
      await client.post("/agents/switch", { id: args[0] });
      const created = await client.post("/sessions/new", { cwd: process.cwd(), agentId: args[0], currentSessionPath: state.sessionPath || undefined });
      state.sessionPath = created.path || state.sessionPath;
      runner.sessionPath = state.sessionPath;
      output.write(`${paint("green", "已切换智能体并新建会话")} ${args[0]}\n`);
    } else {
      await chooseZhAgent(client, rl, state);
    }
  } else if (cmd === "agents") await listZhAgents(client);
  else if (cmd === "skills") await showZhSkills(client);
  else if (cmd === "commands") await showZhCommands(client);
  else if (cmd === "messages") await listZhRecentMessages(client, state, Number(args[0]) || 10);
  else if (cmd === "compact") await runner.run({ type: "compact", sessionPath: state.sessionPath }, { mode: "compact", stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
  else if (cmd === "stop") {
    runner.abort();
    output.write("已发送中断请求。\n");
  } else if (cmd === "clear") {
    output.write("\x1Bc");
    await showZhIntro(client, state);
  } else if (cmd === "image") {
    const imagePath = args.shift();
    if (!imagePath) output.write("用法: /image <路径> [文本]\n");
    else {
      const images = await readImages([imagePath]);
      const text = args.join(" ").trim() || "请查看这张图片";
      await runner.run({ type: "prompt", text, images, sessionPath: state.sessionPath, displayMessage: text }, { stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
    }
  } else {
    await runner.run({ type: "slash", text: line, sessionPath: state.sessionPath }, { mode: "slash", stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
  }
  runner.sessionPath = state.sessionPath;
  return true;
}

async function _handleInteractiveCommand(line, client, rl, state, runner) {
  const [rawCmd, ...rest] = line.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const args = rest.filter(Boolean);
  if (["exit", "quit", "q"].includes(cmd)) return false;
  if (cmd === "help" || cmd === "h") await showInteractiveHelp();
  else if (cmd === "menu") await showMainMenu(client, rl, state, runner);
  else if (cmd === "status") await showStatus(client, state);
  else if (cmd === "new") {
    const created = await client.post("/sessions/new", { cwd: process.cwd(), currentSessionPath: state.sessionPath || undefined });
    state.sessionPath = created.path || state.sessionPath;
    runner.sessionPath = state.sessionPath;
    output.write(`${paint("green", "已新建会话")} ${created.id || ""}\n`);
  } else if (cmd === "session") await chooseSession(client, rl, state);
  else if (cmd === "sessions") await commandSessions(client, ["list"], { json: false });
  else if (cmd === "use") {
    const ref = args.join(" ").trim();
    if (!ref) output.write("用法: /use <session-id|path>\n");
    else {
      const found = await getSessionByRef(client, ref);
      await client.post("/sessions/switch", { sessionPath: found?.path || ref, currentSessionPath: state.sessionPath || undefined });
      state.sessionPath = found?.path || ref;
      runner.sessionPath = state.sessionPath;
      output.write(`${paint("green", "已切换到")} ${found?.id || ref}\n`);
    }
  } else if (cmd === "resume") await resumeInteractiveSession(client, state, runner, args.join(" ").trim());
  else if (cmd === "permissions") await showOrSetInteractivePermissions(client, state, args);
  else if (cmd === "model") await chooseModel(client, rl, state);
  else if (cmd === "models") await commandModels(client, ["list"], { json: false });
  else if (cmd === "agent") {
    if (args[0]) {
      await client.post("/agents/switch", { id: args[0] });
      const created = await client.post("/sessions/new", { cwd: process.cwd(), agentId: args[0], currentSessionPath: state.sessionPath || undefined });
      state.sessionPath = created.path || state.sessionPath;
      runner.sessionPath = state.sessionPath;
      output.write(`${paint("green", "已切换智能体并新建会话")} ${args[0]}\n`);
    } else {
      await chooseAgent(client, rl, state);
    }
  } else if (cmd === "agents") await commandAgents(client, ["list"], { json: false });
  else if (cmd === "skills") await commandSkills(client, [], { json: false });
  else if (cmd === "commands") await commandCommands(client, [], { json: false });
  else if (cmd === "messages") await listRecentMessages(client, state, Number(args[0]) || 10);
  else if (cmd === "compact") await runner.run({ type: "compact", sessionPath: state.sessionPath }, { mode: "compact", stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
  else if (cmd === "stop") {
    runner.abort();
    output.write("已发送中断请求。\n");
  } else if (cmd === "clear") {
    output.write("\x1Bc");
  } else if (cmd === "image") {
    const imagePath = args.shift();
    if (!imagePath) output.write("用法: /image <路径> [文本]\n");
    else {
      const images = await readImages([imagePath]);
      const text = args.join(" ").trim() || "请查看这张图片";
      await runner.run({ type: "prompt", text, images, sessionPath: state.sessionPath, displayMessage: text }, { stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
    }
  } else {
    await runner.run({ type: "slash", text: line, sessionPath: state.sessionPath }, { mode: "slash", stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
  }
  runner.sessionPath = state.sessionPath;
  return true;
}

async function commandInteractive(client, args, _opts) {
  const noIntro = takeFlag(args, "--no-intro");
  const state = { sessionPath: await ensureSession(client, args), modelCache: [] };
  const runner = new WsRunner(client, { sessionPath: state.sessionPath });
  await runner.connect();
  const terminal = input.isTTY && output.isTTY;
  await refreshZhModelCompletionCache(client, state);
  const completer = createZhCompleter(() => state.modelCache || []);
  const rl = terminal
    ? createInterface({ input, output, terminal, completer })
    : {
        question: async () => "",
        close() {},
      };
  const slashHint = terminal ? createZhSlashHintRenderer(rl, () => state.modelCache || []) : null;
  let rlClosed = false;
  rl.on?.("close", () => { rlClosed = true; });
  if (terminal) rl.on("SIGINT", () => {
    if (runner.pending) {
      runner.abort();
      output.write("\n已发送中断请求。\n");
    } else {
      rl.close();
      runner.close();
      process.exit(0);
    }
  });

  if (!noIntro) await showZhIntro(client, state);
  async function handleLine(rawLine) {
    const line = String(rawLine || "").trim();
    if (!line) return true;
    try {
      if (line === "/" || line === "/?") {
        showZhCompletionHint(line, state.modelCache || []);
        return true;
      }
      if (line.startsWith("/")) {
        const keepGoing = await handleZhInteractiveCommand(line, client, rl, state, runner);
        if (/^\/(?:model|models)\b/i.test(line)) await refreshZhModelCompletionCache(client, state);
        return keepGoing;
      }
      await runner.run({ type: "prompt", text: line, sessionPath: state.sessionPath, displayMessage: line }, { stream: true, timeoutMs: INTERACTIVE_TIMEOUT_MS });
    } catch (error) {
      output.write(`${paint("red", "错误:")} ${error.message}\n`);
    }
    return true;
  }

  try {
    if (terminal) {
      for (;;) {
        let line;
        try {
          const promptText = zhPrompt(state);
          slashHint?.activate(promptText);
          line = await rl.question(promptText);
          slashHint?.deactivate(line);
        } catch (error) {
          slashHint?.deactivate();
          if (/readline was closed/i.test(error?.message || "")) break;
          throw error;
        }
        const keepGoing = await handleLine(line);
        if (!keepGoing) break;
      }
    } else {
      const lines = (await readStdinText()).split(/\r?\n/);
      for (const line of lines) {
        const keepGoing = await handleLine(line);
        if (!keepGoing) break;
      }
    }
  } finally {
    slashHint?.close();
    runner.close();
    if (!rlClosed) rl.close?.();
  }
}

async function dispatch(client, command, args, opts) {
  return await dispatchCliCommand(client, command, args, opts, {
    commandHelp: () => output.write(zhHelpText()),
    commandHealth: (_client, _args, dispatchOpts) => commandHealth(_client, dispatchOpts),
    commandChat,
    commandExec,
    commandDoctor,
    commandInteractive,
    commandSessions,
    commandModels,
    commandUsage,
    commandAgents,
    commandSkills,
    commandCommands,
    commandConfig,
    commandServe,
    commandPermissions,
    commandResume,
    commandFs,
    commandRaw,
    helpText: zhHelpText,
  });
}

export async function runCliMain() {
  try {
    await main();
    return 0;
  } catch (error) {
    return handleCliError(error);
  }
}

async function main() {
  const { opts, args } = parseGlobalArgs(process.argv.slice(2), { stdoutIsTTY: output.isTTY });
  setColorEnabled(opts.color);
  const command = args.shift() || "interactive";
  if (["help", "--help", "-h"].includes(command)) {
    output.write(zhHelpText());
    return;
  }
  if (["version", "--version", "-v"].includes(command)) {
    output.write(`${packageVersion()}\n`);
    return;
  }
  if (normalizeCommandName(command) === "serve") {
    await commandServe(null, args, opts);
    return;
  }
  const client = await createClient(opts);
  await dispatch(client, command, args, opts);
}

function handleCliError(error) {
  const code = error instanceof CliError ? error.code : 1;
  if (process.argv.includes("--json")) {
    stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details || undefined }, null, 2)}\n`);
  } else {
    stderr.write(`${paint("red", "错误:")} ${error.message}\n`);
  }
  process.exit(code);
  return code;
}
