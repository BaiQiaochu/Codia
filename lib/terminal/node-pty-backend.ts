import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveTerminalShell } from "./shell-resolver.ts";

export async function createAsyncNodePtyBackend() {
  const pty = await import("node-pty");
  ensureUnixSpawnHelperExecutable();
  return {
    spawn({ command = "", cwd, cols = 80, rows = 24, env, onData, onExit }) {
      const { file, args, env: resolvedEnv } = resolveTerminalShell(command, { env: env || process.env });
      const proc = pty.spawn(file, args, {
        cwd,
        cols,
        rows,
        env: resolvedEnv || env || process.env,
        name: "xterm-256color",
      });
      proc.onData((data) => onData?.(data));
      proc.onExit((event) => onExit?.({ exitCode: event.exitCode, signal: event.signal }));
      return {
        write: (data) => proc.write(data),
        kill: () => proc.kill(),
        resize: (nextCols, nextRows) => proc.resize(nextCols, nextRows),
      };
    },
  };
}

function ensureUnixSpawnHelperExecutable() {
  if (process.platform === "win32") return;
  let packageRoot;
  try {
    packageRoot = path.dirname(fileURLToPath(import.meta.resolve("node-pty/package.json")));
  } catch {
    return;
  }
  for (const helperPath of [
    path.join(packageRoot, "build", "Release", "spawn-helper"),
    path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ]) {
    try {
      if (!fs.existsSync(helperPath)) continue;
      const mode = fs.statSync(helperPath).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, mode | 0o755);
      }
    } catch {}
  }
}
