// @ts-nocheck
/**
  *
 * 定时任务（cron）由独立-cron-scheduler 调度，不经过巡检- */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { debugLog } from "../debug-log.ts";
import {
  WORKSPACE_OUTPUT_ROOT_DIRNAME,
  resolveAgentWorkspaceOutputRelativeDirs,
} from "../../shared/workspace-output.ts";

/**
  * */
export const HEARTBEAT_ACTIVITY_DIR = WORKSPACE_OUTPUT_ROOT_DIRNAME;

/** */
function quickHash(str) {
  return createHash("md5").update(str).digest("hex").slice(0, 12);
}

/** 人类可读文件大小 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

//
/**
  *
 * @param {object} opts
 * @param {boolean} opts.deskChanged - 工作区文件是否有变化
  *
 * @param {string} opts.agentName
 * @param {boolean} opts.isZh
 * @param {string|null} opts.patrolLog - 近期巡检记录（截断后的内容）
 */
function buildHeartbeatContext({ deskChanged, changedFiles, overwatch, isZh, patrolLog, activityDir, patrolLogPath }) {
  const now = new Date();
  const timeStr = now.toLocaleString(isZh ? "zh-CN" : "en-US", { hour12: false });

  const parts = [
    `[Heartbeat Patrol] Current time: ${timeStr}`,
    "",
    "**Note: This is an automated patrol message, not a user message.**",
    "Independently decide whether anything needs proactive handling. If action is needed, act directly without asking the user to reply.",
    "",
  ];

  if (overwatch) {
    parts.push("## Overwatch", overwatch, "");
  }

  if (deskChanged && changedFiles) {
    parts.push("## Workspace file changes");
    if (changedFiles.added.length > 0) {
      parts.push("Added:");
      for (const f of changedFiles.added) parts.push(`  + ${f}`);
    }
    if (changedFiles.modified.length > 0) {
      parts.push("Modified:");
      for (const f of changedFiles.modified) parts.push(`  ~ ${f}`);
    }
    if (changedFiles.removed.length > 0) {
      parts.push("Removed:");
      for (const f of changedFiles.removed) parts.push(`  - ${f}`);
    }
    parts.push("");
  } else {
    parts.push("## Workspace status: no file changes", "");
  }

  if (patrolLog) {
    parts.push("## Recent Patrol Log", patrolLog, "");
  }

  parts.push("---");
  parts.push([
    `1. Check the activity directory first: list files under \`${activityDir}/\` and avoid duplicate work.`,
    "2. Review the recent patrol log and avoid repeating work already done.",
    "3. Use memory and context to decide if there is anything useful to do proactively for the user.",
    "4. If something noteworthy needs the user's attention, use the notify tool.",
    `5. If you create proactive files, place them under \`${activityDir}/\` in the workspace.`,
    "6. You may use downtime to learn about broad topics the user cares about and save useful findings.",
    "7. Do not proactively query system status that was not provided above.",
    "8. If no action is needed, do not call tools, but still append a patrol log entry.",
    `9. Append the final log to \`${patrolLogPath}\` using \`- [YYYY-MM-DD HH:mm] what you did\`. If nothing was done, write \`- [YYYY-MM-DD HH:mm] Patrol complete, no action needed\`.`,
  ].join("\n"));

  return parts.join("\n");
}

function buildJianPrompt({ dirPath, jianContent, files, jianChanged, filesChanged, isZh }) {
  const { instructions, execLog } = splitJianContent(jianContent);

  const parts = [
    `[Directory Patrol] ${dirPath}`,
    "",
    "**Note: This is an automated directory patrol, not a user message.**",
    "Follow the jian instructions independently. Do not ask the user or wait for a reply.",
    "",
    "## Jian",
    instructions,
    "",
  ];

  if (execLog) {
    parts.push("## Past Execution Log", execLog, "");
  }

  if (files.length > 0) {
    parts.push("## File list");
    for (const f of files) {
      const prefix = f.isDir ? "[dir] " : "[file] ";
      const size = f.isDir ? "" : ` (${formatSize(f.size)})`;
      parts.push(`- ${prefix}${f.name}${size}`);
    }
    parts.push("");
  }

  parts.push("## Changes");
  parts.push(`- jian.md: ${jianChanged ? "changed" : "unchanged"}`);
  parts.push(`- files: ${filesChanged ? "changed" : "unchanged"}`);
  parts.push("");
  parts.push([
    "## Action Rules",
    "",
    "1. Check the execution log first to decide whether each instruction is one-time, recurring, or conditional.",
    "2. Skip one-time tasks that already have a completed log entry.",
    "3. Execute recurring tasks on every patrol and evaluate conditional tasks against their condition.",
    "4. After completing tasks, append a result under the exec-log section in jian.md.",
    "5. If no action is needed, do not call tools and do not add a log entry.",
  ].join("\n"));

  return parts.join("\n");
}

const PATROL_LOG_MAX_ENTRIES = 50;

/**
  *
 * @returns {string|null} 截断后的内容（null = 文件不存在或为空- */
function readAndTruncatePatrolLog(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const lines = raw.split("\n");
  const entries = lines.filter(l => l.startsWith("- ["));
  if (entries.length === 0) return null;

  if (entries.length > PATROL_LOG_MAX_ENTRIES) {
    const kept = entries.slice(-PATROL_LOG_MAX_ENTRIES);
    try {
      fs.writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
    } catch {}
    return kept.join("\n");
  }
  return entries.join("\n");
}

//
/**
  * */
function listDirFiles(dir, ignoreNames = new Set()) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "jian.md" && !ignoreNames.has(e.name))
      .map(e => {
        const fp = path.join(dir, e.name);
        let stat;
        try { stat = fs.lstatSync(fp); } catch { return null; }
        if (stat.isSymbolicLink()) return null; // 跳过 symlink
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
  * */
function scanJianDirs(wsPath) {
  if (!wsPath || !fs.existsSync(wsPath)) return [];

  const dirs = [];
  const rootIgnoreNames = new Set([WORKSPACE_OUTPUT_ROOT_DIRNAME]);

 //
  if (fs.existsSync(path.join(wsPath, "jian.md"))) {
    try {
      dirs.push({
        name: ".",
        absPath: wsPath,
        jianContent: fs.readFileSync(path.join(wsPath, "jian.md"), "utf-8"),
        files: listDirFiles(wsPath, rootIgnoreNames),
      });
    } catch {}
  }

 // 丢级子目录
  try {
    const entries = fs.readdirSync(wsPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (e.name === WORKSPACE_OUTPUT_ROOT_DIRNAME) continue;
      const subPath = path.join(wsPath, e.name);
      const jianFile = path.join(subPath, "jian.md");
      if (!fs.existsSync(jianFile)) continue;
      try {
        dirs.push({
          name: e.name,
          absPath: subPath,
          jianContent: fs.readFileSync(jianFile, "utf-8"),
          files: listDirFiles(subPath),
        });
      } catch {}
    }
  } catch {}

  return dirs;
}

//
/**
  *
 * @param {object} opts
 * @param {() => Array|Promise<Array>} [opts.getDeskFiles] - 获取根目录文件列表（支持 async- * @param {() => string} [opts.getWorkspacePath] - 获取工作空间路径
 * @param {() => string} [opts.getAgentName] - 获取当前 agent 名称
 * @param {string} [opts.registryPath] - jian-registry.json 存储路径
 * @param {(prompt: string) => Promise<void>} opts.onBeat - 工作空间巡检回调
  *
 * @returns {{ start, stop, beat, triggerNow }}
 */
export function createHeartbeat({
  getDeskFiles, getWorkspacePath, getAgentName, registryPath,
  onBeat, onJianBeat,
  intervalMinutes, emitDevLog,
  overwatchPath, locale,
}) {
  const isZh = !locale || String(locale).startsWith("zh");
  const devlog = (text, level = "heartbeat") => {
    emitDevLog?.(text, level);
  };
  const INTERVAL = (intervalMinutes || 31) * 60 * 1000;
  const COOLDOWN = 2 * 60 * 1000;
  const BEAT_TIMEOUT = 5 * 60 * 1000;

  let _timer = null;
  let _running = false;
  let _beatPromise = null;
  let _lastTrigger = 0;
 /** */
  const _lastDeskSnapshot = new Map();

  //

  function loadRegistry() {
    if (!registryPath) return {};
    try {
      return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveRegistry(reg) {
    if (!registryPath) return;
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[heartbeat] saveRegistry 失败: ${err.message}`);
    }
  }

 // -- 心跳执行 --

  async function beat() {
    if (_running) return;
    _running = true;
    const p = _doBeat();
    _beatPromise = p;
    await p;
  }

  async function _doBeat() {
    try {
      const tag = "\x1b[36m[heartbeat]\x1b[0m";
      console.log(`${tag} -- 心跳开始 --`);
      debugLog()?.log("heartbeat", "beat start");
      devlog("-- 心跳开始 --");

 //
      const deskFiles = (await getDeskFiles?.()) || [];

 // 差量 diff：对比上丢轮快照，算出 added / modified / removed
      const currentSnapshot = new Map(deskFiles.map(f => [f.name, f.mtime || 0]));
      const changedFiles = { added: [], modified: [], removed: [] };
      for (const [name, mtime] of currentSnapshot) {
        if (!_lastDeskSnapshot.has(name)) changedFiles.added.push(name);
        else if (_lastDeskSnapshot.get(name) !== mtime) changedFiles.modified.push(name);
      }
      for (const name of _lastDeskSnapshot.keys()) {
        if (!currentSnapshot.has(name)) changedFiles.removed.push(name);
      }
      const deskChanged = changedFiles.added.length > 0 || changedFiles.modified.length > 0 || changedFiles.removed.length > 0;
 // 更新快照（不管有没有变化都更新，保持准确- _lastDeskSnapshot = currentSnapshot;

 //
      let overwatch = null;
      if (overwatchPath) {
        try {
          const content = fs.readFileSync(overwatchPath, "utf-8").trim();
          if (content) overwatch = content;
        } catch {}
      }

 //
      const wsPath = getWorkspacePath?.();
      const jianDirs = (onJianBeat && wsPath) ? scanJianDirs(wsPath) : [];
      const jianChanges = _detectJianChanges(jianDirs);

      //
      const changeCount = changedFiles.added.length + changedFiles.modified.length + changedFiles.removed.length;
      const summaryParts = [isZh ? `文件: ${deskFiles.length}${deskChanged ? ` (${changeCount} 变化)` : ""}` : `files: ${deskFiles.length}${deskChanged ? ` (${changeCount} changed)` : ""}`];
      if (overwatch) summaryParts.push("overwatch: active");
      if (jianDirs.length > 0) summaryParts.push(`jian: ${jianDirs.length} dirs, ${jianChanges.length} changed`);
      const summary = summaryParts.join("  |  ");
      console.log(`${tag}  ${summary}`);
      devlog(summary);

 //
      {
        const agentName = getAgentName?.() || "助手";
        const relativeOutputDirs = resolveAgentWorkspaceOutputRelativeDirs(agentName, locale);
 // 读取巡检日志（截断）
        const absolutePatrolLogPath = wsPath ? path.join(wsPath, ...relativeOutputDirs.patrolLog.split("/")) : null;
        const patrolLog = absolutePatrolLogPath ? readAndTruncatePatrolLog(absolutePatrolLogPath) : null;
        const prompt = buildHeartbeatContext({
          deskChanged,
          changedFiles,
          overwatch,
          agentName,
          isZh,
          patrolLog,
          activityDir: relativeOutputDirs.activityDir,
          patrolLogPath: relativeOutputDirs.patrolLog,
        });
        console.log(`${tag}  Phase 1: workspace patrol (${prompt.length} chars, ${deskChanged ? "changed" : "unchanged"})`);
        devlog(`Phase 1: workspace patrol running${deskChanged ? "" : " (no file changes)"}`);
        {
          let timer;
          try {
            await Promise.race([
              onBeat(prompt),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Heartbeat timed out (5min)")), BEAT_TIMEOUT); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
      }

 //
      if (jianChanges.length > 0) {
        await _processJianChanges(jianChanges, tag);
      }

      console.log(`${tag} -- heartbeat complete --`);
      debugLog()?.log("heartbeat", "beat done");
      devlog("heartbeat complete");
    } catch (err) {
      console.error(`[heartbeat] beat error: ${err.message}`);
      debugLog()?.error("heartbeat", `beat error: ${err.message}`);
      devlog(`错误: ${err.message}`, "error");
    } finally {
      _running = false;
    }
  }

  /**
 * 对比注册表，找出有变化的笺目- */
  function _detectJianChanges(jianDirs) {
    if (jianDirs.length === 0) return [];

    const registry = loadRegistry();
    const result = [];

    for (const dir of jianDirs) {
      const key = dir.absPath;
      const jianHash = quickHash(dir.jianContent);
      const filesHash = quickHash(dir.files.map(f => `${f.name}:${f.mtime}`).join("|"));

      const prev = registry[key];
      const jianChanged = !prev || prev.jianHash !== jianHash;
      const filesChanged = !prev || prev.filesHash !== filesHash;

 // 有内容就触发，agent 自己决定要不要行-
      result.push({ ...dir, jianHash, filesHash, jianChanged, filesChanged });
    }

    return result;
  }

  /**
 * 逐个执行有变化的笺目- */
  async function _processJianChanges(changes, tag) {
    const registry = loadRegistry();

    for (const dir of changes) {
      const label = dir.name === "." ? "root" : dir.name;
      console.log(`${tag}  Phase 2: jian [${label}] changed, running...`);
      devlog(`jian [${label}] changed, running...`);

      const prompt = buildJianPrompt({
        dirPath: dir.absPath,
        jianContent: dir.jianContent,
        files: dir.files,
        jianChanged: dir.jianChanged,
        filesChanged: dir.filesChanged,
        isZh,
      });

      try {
        {
          let timer;
          try {
            await Promise.race([
              onJianBeat(prompt, dir.absPath),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Jian [${label}] timed out (5min)`)), BEAT_TIMEOUT); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }

 // 执行成功 -重新扫描目录，用执行后的指纹存入 registry
 // 避免任务自身修改文件导致下次心跳重复触发（自濢振荡-
        const postFiles = listDirFiles(dir.absPath);
        const postFilesHash = quickHash(postFiles.map(f => `${f.name}:${f.mtime}`).join("|"));
        let postJianHash = dir.jianHash;
        try {
          const postJian = fs.readFileSync(path.join(dir.absPath, "jian.md"), "utf-8");
          postJianHash = quickHash(postJian);
        } catch {}

        registry[dir.absPath] = {
          jianHash: postJianHash,
          filesHash: postFilesHash,
          lastCheckedAt: new Date().toISOString(),
        };
        saveRegistry(registry);

        devlog(`[${label}] completed`);
      } catch (err) {
        devlog(`[${label}] failed: ${err.message}`, "error");
      }
    }
  }

  // ── 调度 ──

  function start() {
    if (_timer) return;
    const now = Date.now();
    const msIntoSlot = now % INTERVAL;
    const delay = INTERVAL - msIntoSlot;
    const nextTime = new Date(now + delay);
    console.log(`\x1b[90m[heartbeat] 已启动，下次心跳: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}\x1b[0m`);
    debugLog()?.log("heartbeat", `started, next: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    devlog(`心跳已启动，下次: ${nextTime.toLocaleTimeString("zh-CN", { hour12: false })}`);
    _timer = setTimeout(function fire() {
      beat();
      _timer = setInterval(() => beat(), INTERVAL);
      if (_timer.unref) _timer.unref();
    }, delay);
    if (_timer.unref) _timer.unref();
  }

  async function stop() {
    if (_timer) {
      clearTimeout(_timer);
      clearInterval(_timer);
      _timer = null;
    }
    if (_beatPromise) {
      await _beatPromise.catch(() => {});
    }
    _running = false; // 确保 stop 后状态干净
    debugLog()?.log("heartbeat", "stopped");
    devlog("heartbeat stopped");
  }

  function triggerNow() {
    const now = Date.now();
    if (now - _lastTrigger < COOLDOWN) {
      devlog("手动触发冷却中，跳过");
      return false;
    }
    _lastTrigger = now;
    devlog("手动触发心跳");
    beat();
    return true;
  }

  return { start, stop, beat, triggerNow };
}
