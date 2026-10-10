/**
 * Persistent diagnostic log.
 *
 * A new timestamped log file is created for each server process. Messages are
 * redacted before they are written and repeated adjacent messages are compacted.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { redactLogLabel, redactLogText } from "./log-redactor.ts";

type DedupState = {
  level: string | null;
  module: string | null;
  msg: string | null;
  count: number;
};

type HeaderInfo = {
  model?: string;
  agent?: string;
  agentId?: string;
  utilityModel?: string;
  channelsDir?: string;
};

class DebugLog {
  private _dedup: DedupState = { level: null, module: null, msg: null, count: 0 };
  private _filePath: string;
  private _logDir: string;
  private _redactOptions: { homeDir: string };
  private _size = 0;
  private _truncated = false;

  constructor(logDir: string) {
    fs.mkdirSync(logDir, { recursive: true });

    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-") + "_" + [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("-");

    this._filePath = path.join(logDir, `${ts}.log`);
    this._logDir = logDir;
    this._redactOptions = { homeDir: os.homedir() };
    this._cleanup(7);
  }

  get filePath() {
    return this._filePath;
  }

  header(version: string, info: HeaderInfo = {}) {
    const lines = [
      "=".repeat(60),
      `Codia v${version} started at ${new Date().toISOString()}`,
      "=".repeat(60),
    ];

    if (info.model) lines.push(`Model: ${info.model}`);
    if (info.agent) lines.push(`Agent: ${info.agent} (${info.agentId || "?"})`);
    if (info.utilityModel) lines.push(`Utility: ${info.utilityModel}`);
    if (info.channelsDir) lines.push("Channels: configured");

    lines.push("-".repeat(60), "");
    fs.appendFileSync(
      this._filePath,
      lines.map((line) => redactLogText(line, this._redactOptions)).join("\n") + "\n",
      "utf-8",
    );
  }

  close() {
    this._flushDedup();
    this._write("INFO", "system", "Server shutting down");
    fs.appendFileSync(this._filePath, "\n" + "=".repeat(60) + "\n", "utf-8");
  }

  log(module: string, msg: unknown) {
    this._write("INFO", module, msg);
  }

  error(module: string, msg: unknown) {
    this._write("ERROR", module, msg);
  }

  warn(module: string, msg: unknown) {
    this._write("WARN", module, msg);
  }

  tail(n = 100): string[] {
    try {
      const content = fs.readFileSync(this._filePath, "utf-8");
      const lines = content.split("\n");
      return lines.slice(-n);
    } catch {
      return [];
    }
  }

  private _write(level: string, module: string, msg: unknown) {
    const cleanModule = redactLogLabel(module || "unknown");
    const cleaned = redactLogText(String(msg), this._redactOptions);
    const d = this._dedup;

    if (d.level === level && d.module === cleanModule && d.msg === cleaned) {
      d.count++;
      return;
    }

    this._flushDedup();
    this._dedup = { level, module: cleanModule, msg: cleaned, count: 1 };
    this._append(level, cleanModule, cleaned);
  }

  private _flushDedup() {
    const d = this._dedup;
    if (d.count > 1) {
      this._append("INFO", "dedup", `Previous log line repeated ${d.count} times`);
    }
    this._dedup = { level: null, module: null, msg: null, count: 0 };
  }

  private _append(level: string, module: string, msg: string) {
    const MAX = 5 * 1024 * 1024;
    if (this._truncated) return;

    if (this._size >= MAX) {
      try {
        fs.appendFileSync(this._filePath, "\n[Log reached 5MB limit; further content truncated]\n", "utf-8");
      } catch {
        // Logging must never block runtime work.
      }
      this._truncated = true;
      return;
    }

    const now = new Date();
    const time = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join(":") + "." + String(now.getMilliseconds()).padStart(3, "0");
    const line = `[${time}] [${level}] [${module}] ${msg}\n`;

    try {
      fs.appendFileSync(this._filePath, line, "utf-8");
      this._size += Buffer.byteLength(line, "utf-8");
    } catch {
      // Logging must never block runtime work.
    }
  }

  private _cleanup(maxDays: number) {
    try {
      const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(this._logDir).filter((f) => f.endsWith(".log"));

      for (const f of files) {
        const filePath = path.join(this._logDir, f);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
      }
    } catch {
      // Cleanup failure should not affect startup.
    }
  }
}

let _instance: DebugLog | null = null;

export function initDebugLog(logDir: string): DebugLog {
  _instance = new DebugLog(logDir);
  return _instance;
}

export function debugLog(): DebugLog | null {
  return _instance;
}

function formatLoggerMessage(msg: unknown, extra: unknown[]): string {
  if (!extra.length) return String(msg);
  return [msg, ...extra].map((item) => {
    if (item instanceof Error) return item.stack || item.message;
    if (typeof item === "string") return item;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).join(" ");
}

export function createModuleLogger(module: string) {
  return {
    log(msg: unknown, ...extra: unknown[]) {
      const text = formatLoggerMessage(msg, extra);
      console.log(`[${module}] ${text}`);
      _instance?.log(module, text);
    },
    warn(msg: unknown, ...extra: unknown[]) {
      const text = formatLoggerMessage(msg, extra);
      console.warn(`[${module}] ${text}`);
      _instance?.warn(module, text);
    },
    error(msg: unknown, ...extra: unknown[]) {
      const text = formatLoggerMessage(msg, extra);
      console.error(`[${module}] ${text}`);
      _instance?.error(module, text);
    },
  };
}
