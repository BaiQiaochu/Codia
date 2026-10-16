// @ts-nocheck
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export class McpStdioClient {
  constructor(server, { log = console, onClose = null } = {}) {
    this.server = server;
    this.log = log;
    this.onClose = onClose;
    this.process = null;
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuffer = "";
    this._closed = false;
    this._stopping = false;
    this._closeSettled = false;
  }

  get running() {
    return !!this.process && !this._closed && this.process.exitCode == null;
  }

  async start() {
    if (this.running) return;
    if (!this.server?.command) throw new Error("MCP server command is required");

    this._closed = false;
    this._stopping = false;
    this._closeSettled = false;
    const spawnSpec = this.server.resolveWindowsShims === false
      ? resolveMcpStdioSpawnSpec(this.server, { platform: "direct" })
      : resolveMcpStdioSpawnSpec(this.server);
    this.process = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.server.cwd || undefined,
      env: spawnSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    this.process.stdout.setEncoding("utf-8");
    this.process.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.process.stderr.setEncoding("utf-8");
    this.process.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log.debug?.(`[mcp:${this.server.id}] ${text}`);
    });
    this.process.on("exit", (code, signal) => {
      this._settleProcessClose({ code, signal });
    });
    this.process.on("error", (err) => {
      this._settleProcessClose({ error: err });
    });

    await this.initialize();
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "codia",
        title: "Codia",
        version: "0.6.7",
      },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    return this.request("tools/call", {
      name,
      arguments: args || {},
    });
  }

  request(method, params = {}, { timeout = 30_000 } = {}) {
    if (!this.running) throw new Error("MCP server is not running");
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeout);
      this._pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this._send(payload);
    });
  }

  notify(method, params = {}) {
    if (!this.running) return;
    this._send({ jsonrpc: "2.0", method, params });
  }

  async stop() {
    if (!this.process) return;
    const proc = this.process;
    this._stopping = true;
    this._closed = true;
    await new Promise((resolve) => {
      let done = false;
      let termTimer = null;
      let killTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        this.process = null;
        resolve();
      };
      proc.once("exit", finish);
      try { proc.stdin.end(); } catch {}
      if (done || proc.exitCode != null) {
        finish();
        return;
      }
      termTimer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
      }, 2_000);
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 5_000);
    });
    this._stopping = false;
  }

  _send(payload) {
    const line = JSON.stringify(payload);
    this.process.stdin.write(line + "\n", "utf-8");
  }

  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    while (true) {
      const idx = this._stdoutBuffer.indexOf("\n");
      if (idx === -1) return;
      const line = this._stdoutBuffer.slice(0, idx).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        this.log.warn?.(`[mcp:${this.server.id}] ignored non-JSON stdout: ${err.message}`);
        continue;
      }
      this._handleMessage(message);
    }
  }

  _handleMessage(message) {
    if (message?.id == null) return;
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "MCP request failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  _settleProcessClose({ code = null, signal = null, error = null } = {}) {
    if (this._closeSettled) return;
    this._closeSettled = true;

    const expected = this._stopping;
    this._closed = true;
    this.process = null;
    const reason = error?.message || signal || (code ?? "unknown");
    const pendingError = error || new Error(`MCP server exited (${reason})`);
    for (const pending of this._pending.values()) pending.reject(pendingError);
    this._pending.clear();

    if (!expected && typeof this.onClose === "function") {
      const info = {
        id: this.server.id,
        expected: false,
        reason,
      };
      if (error) info.error = error;
      else {
        info.code = code;
        info.signal = signal;
      }
      this.onClose(info);
    }
  }
}

export function resolveMcpStdioSpawnSpec(server, {
  platform = process.platform,
  baseEnv = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const rawCommand = String(server?.command || "");
  const rawArgs = Array.isArray(server?.args) ? server.args.map((arg) => String(arg)) : [];
  const env = {
    ...baseEnv,
    ...(server?.env || {}),
  };
  if (server?.registryUrl) {
    env.NPM_CONFIG_REGISTRY = String(server.registryUrl);
  }
  if (platform !== "win32") {
    return { command: rawCommand, args: rawArgs, env };
  }

  const command = resolveWindowsCommand(rawCommand, baseEnv, existsSync);
  const ext = path.win32.extname(command).toLowerCase();
  if (ext === ".exe") {
    return { command, args: rawArgs, env };
  }
  if (ext === ".cmd" || ext === ".bat" || ext === ".com" || !ext) {
    const comspec = String(baseEnv.ComSpec || baseEnv.COMSPEC || "cmd.exe");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", buildWindowsCommandLine(command, rawArgs)],
      env,
    };
  }
  return { command, args: rawArgs, env };
}

function resolveWindowsCommand(command, env, existsSync) {
  if (isPathLike(command)) return command;
  const pathValue = String(env.Path || env.PATH || "");
  const pathDirs = pathValue.split(";").filter(Boolean);
  const extensions = path.win32.extname(command)
    ? [""]
    : String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((ext) => ext.trim())
      .filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.win32.join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function isPathLike(command) {
  return command.includes("\\") || command.includes("/") || /^[A-Za-z]:/.test(command);
}

function buildWindowsCommandLine(command, args) {
  return [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(" ");
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[ \t"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}
