#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const upstreamDir = process.argv[2] || "openhanako-0.303.3";
const outputPath = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "";
const upstreamRoot = path.resolve(ROOT, upstreamDir);

const excludedParts = [
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "dist-server",
  "dist-server-bundle",
  "dist-computer-use",
  "dist-sandbox",
  "desktop/dist-renderer",
  "coverage",
  "release",
  "out",
  "build",
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isExcluded(relativePath) {
  const normalized = toPosix(relativePath);
  if (/^openhanako-[^/]+(?:\/|$)/.test(normalized)) return true;
  return excludedParts.some((part) => normalized === part || normalized.startsWith(`${part}/`));
}

function isTypeScriptCompatShim(file) {
  const parsed = path.parse(file);
  const localTs = path.join(parsed.dir, `${parsed.name}.ts`);
  const localTsx = path.join(parsed.dir, `${parsed.name}.tsx`);
  if (!fs.existsSync(localTs) && !fs.existsSync(localTsx)) return false;

  const text = fs.readFileSync(file, "utf8").trim();
  const escapedName = parsed.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shimPattern = new RegExp(
    `^export\\s+(?:\\*|\\{[\\s\\S]*\\})\\s+from\\s+[\"']\\./${escapedName}\\.(?:ts|tsx)[\"'];?$`,
  );
  return shimPattern.test(text);
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);
    if (isExcluded(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

if (!fs.existsSync(upstreamRoot)) {
  console.error(`[ts-migration-inventory] upstream snapshot not found: ${upstreamRoot}`);
  process.exit(1);
}

const candidates = [];
for (const file of walk(ROOT)) {
  if (!file.endsWith(".js") && !file.endsWith(".jsx")) continue;
  const relativePath = path.relative(ROOT, file);
  if (isExcluded(relativePath)) continue;
  if (isTypeScriptCompatShim(file)) continue;
  const parsed = path.parse(relativePath);
  const tsPath = path.join(upstreamRoot, parsed.dir, `${parsed.name}.ts`);
  const tsxPath = path.join(upstreamRoot, parsed.dir, `${parsed.name}.tsx`);
  if (fs.existsSync(tsPath)) {
    candidates.push({
      source: toPosix(relativePath),
      upstream: toPosix(path.relative(upstreamRoot, tsPath)),
    });
  } else if (fs.existsSync(tsxPath)) {
    candidates.push({
      source: toPosix(relativePath),
      upstream: toPosix(path.relative(upstreamRoot, tsxPath)),
    });
  }
}

candidates.sort((a, b) => a.source.localeCompare(b.source));
const grouped = candidates.reduce((acc, item) => {
  const top = item.source.split("/")[0];
  acc[top] = (acc[top] || 0) + 1;
  return acc;
}, {});

const output = { upstreamDir, total: candidates.length, grouped, candidates };
const json = `${JSON.stringify(output, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, outputPath), json, "utf8");
} else {
  console.log(json.trimEnd());
}
