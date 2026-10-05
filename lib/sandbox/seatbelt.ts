// @ts-nocheck
/**
  *
 *
  * */

import fs from "fs";
import { spawnAndStream } from "./exec-helper.ts";
import { writeScript, writeProfile, cleanup } from "./script.ts";

/**
 * 创建 macOS 沙盒化的 exec 函数
  *
 * @returns {(command, cwd, opts) => Promise<{exitCode}>}
 */
export function createSeatbeltExec(policy, { getSandboxNetworkEnabled } = {}) {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    const { scriptPath } = writeScript(command, cwd);
    const profile = generateProfile(policy, {
      allowNetwork: typeof getSandboxNetworkEnabled === "function"
        ? getSandboxNetworkEnabled()
        : true,
    });
    const { profilePath } = writeProfile(profile);
    try {
      return await spawnAndStream(
        "sandbox-exec",
        ["-f", profilePath, "/bin/bash", scriptPath],
        { cwd, env, onData, signal, timeout },
      );
    } finally {
      cleanup(scriptPath, profilePath);
    }
  };
}

/**
  * */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 生成 Seatbelt SBPL profile
 */
function generateProfile(policy, { allowNetwork = true } = {}) {
  const lines = [
    "(version 1)",
    "(deny default)",
    "",
    ";; 进程",
    "(allow process-exec* process-fork signal)",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix*)",
    "",
    ";; 全局可读",
    "(allow file-read*)",
    "",
    ";; 可写路径",
  ];

  for (const p of policy.writablePaths) {
    lines.push(`(allow file-write* (subpath "${realpath(p)}"))`);
  }

 //
  lines.push(
    `(allow file-write* (subpath "/private/tmp"))`,
    `(allow file-write* (subpath "${realpath(process.env.TMPDIR || "/tmp")}"))`
  );

  lines.push("");

 //
  if (policy.protectedPaths.length) {
    lines.push(";; write protection");
    for (const p of policy.protectedPaths) {
      lines.push(`(deny file-write* (subpath "${realpath(p)}"))`);
    }
    lines.push("");
  }

 // 读取拒绝（subpath 覆盖文件和目录及其内容）
  if (policy.denyReadPaths.length) {
    lines.push(";; 读取拒绝");
    for (const p of policy.denyReadPaths) {
      const rp = realpath(p);
      lines.push(`(deny file-read* (subpath "${rp}"))`);
      lines.push(`(deny file-write* (subpath "${rp}"))`);
    }
    lines.push("");
  }

  lines.push(
    ";; 终端 + PTY",
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-write* (literal "/dev/ptmx"))',
    "(allow pseudo-tty)",
    "",
    ";; 网络（默认封闭）",
  );
  lines.push(allowNetwork ? "(allow network-outbound)" : "(deny network*)");

  return lines.join("\n");
}

export const __testing = { generateProfile };
