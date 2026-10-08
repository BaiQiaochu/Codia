#!/usr/bin/env node

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const root = process.argv[2] || path.join(process.cwd(), "vendor", "git-portable");
const git = path.join(root, "cmd", "git.exe");
const bash = fs.existsSync(path.join(root, "bin", "bash.exe"))
  ? path.join(root, "bin", "bash.exe")
  : path.join(root, "usr", "bin", "bash.exe");

function run(label, exe, args) {
  try {
    const out = execFileSync(exe, args, { encoding: "utf-8", timeout: 20000 });
    console.log(`PASS  ${label}: ${out.trim().split(/\r?\n/)[0]}`);
    return true;
  } catch (err) {
    console.error(`FAIL  ${label}: ${err?.message || String(err)}`);
    return false;
  }
}

const coreutils = "cat ls cp mv rm mkdir grep sed awk find sort uniq head tail wc cut tr xargs echo touch chmod";

const results = [
  run("git --version", git, ["--version"]),
  run("bash starts", bash, ["-lc", "echo bash=$BASH_VERSION"]),
  run("coreutils present", bash, [
    "-lc",
    `missing=""; for t in ${coreutils}; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done; ` +
      `if [ -n "$missing" ]; then echo "MISSING:$missing"; exit 1; fi; echo "coreutils ok"`,
  ]),
  run("bash pipeline", bash, [
    "-lc",
    "printf 'a\\nb\\nc\\n' | grep b | sed 's/b/B/' | awk '{print $1}'",
  ]),
];

process.exit(results.every(Boolean) ? 0 : 1);
