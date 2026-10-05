#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const PRUNE_DIRS = [
  "mingw64/share/doc",
  "usr/share/doc",
  "usr/share/man",
  "mingw64/share/man",
  "usr/share/info",
  "mingw64/share/info",
  "usr/include",
  "mingw64/include",
  "mingw64/share/git-gui",
  "mingw64/share/gitk",
  "mingw64/share/gitweb",
  "usr/lib/perl5",
  "usr/share/perl5",
  "mingw64/lib/perl5",
  "mingw64/share/perl5",
  "mingw64/share/locale",
  "usr/share/locale",
  "mingw64/lib/pkgconfig",
  "usr/lib/pkgconfig",
  "mingw64/lib/cmake",
  "mingw64/share/aclocal",
  "usr/share/aclocal",
  "usr/share/vim",
  "usr/share/nano",
];

export const PRUNE_DIR_PREFIXES = [
  { parent: "mingw64/lib", prefix: "tcl" },
  { parent: "mingw64/lib", prefix: "tk" },
  { parent: "mingw64/lib", prefix: "itcl" },
  { parent: "mingw64/lib", prefix: "tdbc" },
  { parent: "mingw64/lib", prefix: "thread" },
];

export const PRUNE_FILES = [
  { dir: "", names: ["git-bash.exe", "git-cmd.exe"] },
  { dir: "cmd", names: ["git-gui.exe", "gitk.exe", "git-bash.exe"], prefixes: ["start-"] },
  { dir: "mingw64/bin", prefixes: ["wish", "tclsh", "perl", "svn", "vim"] },
  {
    dir: "usr/bin",
    prefixes: ["perl"],
    names: ["vi.exe", "view.exe", "vim.exe", "vimdiff.exe", "rvim.exe", "rview.exe", "nano.exe"],
  },
  {
    dir: "mingw64/libexec/git-core",
    names: [
      "git-svn",
      "git-send-email",
      "git-add--interactive",
      "git-archimport",
      "git-cvsimport",
      "git-cvsexportcommit",
      "git-cvsserver",
      "git-instaweb",
      "git-p4",
      "git-gui",
      "git-gui--askpass",
      "git-citool",
      "gitk",
    ],
  },
];

export const RETAIN_ASSERTIONS = [
  "cmd/git.exe",
  "bin/bash.exe",
  "usr/bin/bash.exe",
  "usr/bin/msys-2.0.dll",
  "mingw64/bin/git.exe",
];

function statPathUsage(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(fullPath).size;
        } catch {}
      }
    }
  }
  return { bytes, files };
}

function removePath(target, dryRun) {
  const usage = statPathUsage(target);
  if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  return usage;
}

export function prunePortableGitRuntime(root, { dryRun = false, logger = console } = {}) {
  if (!fs.existsSync(root)) {
    throw new Error(`[prune-git-portable] runtime root not found: ${root}`);
  }

  let removedDirs = 0;
  let removedFiles = 0;
  let removedBytes = 0;

  for (const rel of PRUNE_DIRS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const { bytes } = removePath(abs, dryRun);
    removedDirs += 1;
    removedBytes += bytes;
  }

  for (const { parent, prefix } of PRUNE_DIR_PREFIXES) {
    const parentAbs = path.join(root, parent);
    let entries = [];
    try {
      entries = fs.readdirSync(parentAbs, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue;
      const { bytes } = removePath(path.join(parentAbs, entry.name), dryRun);
      removedDirs += 1;
      removedBytes += bytes;
    }
  }

  for (const rule of PRUNE_FILES) {
    const dirAbs = path.join(root, rule.dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const lower = name.toLowerCase();
      const hit =
        (rule.names || []).includes(name) ||
        (rule.names || []).includes(lower) ||
        (rule.prefixes || []).some((prefix) => lower.startsWith(prefix));
      if (!hit) continue;
      const { bytes } = removePath(path.join(dirAbs, name), dryRun);
      removedFiles += 1;
      removedBytes += bytes;
    }
  }

  const missing = RETAIN_ASSERTIONS.filter((rel) => !fs.existsSync(path.join(root, rel)));
  if (missing.length) {
    throw new Error(
      "[prune-git-portable] refused to produce an incomplete Git runtime; 缺失关键文件 / missing:\n" +
      missing.map((rel) => `  - ${rel}`).join("\n"),
    );
  }

  const stats = {
    dryRun,
    removedDirs,
    removedFiles,
    removedMB: +(removedBytes / 1048576).toFixed(1),
  };
  logger.log(
    `[prune-git-portable] ${dryRun ? "(dry-run) " : ""}` +
    `dirs=${removedDirs} files=${removedFiles} freed~${stats.removedMB}MB`,
  );
  return stats;
}

function main(argv = process.argv) {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const runtimeRoot = positional[0] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "git-portable");
  prunePortableGitRuntime(path.resolve(runtimeRoot), { dryRun: argv.includes("--dry-run") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
}
