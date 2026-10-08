// @ts-nocheck
import fs from "fs";
import path from "path";

const WORKSPACE_INSTRUCTION_FILES = [
  { filename: "AGENTS.md", key: "inject_agents_md" },
  { filename: "CLAUDE.md", key: "inject_claude_md" },
];

function normalizeComparePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return normalizeComparePath(a) === normalizeComparePath(b);
}

function existingDirectory(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  try {
    const resolved = path.resolve(rawPath);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return resolved;
    if (stat.isFile()) return path.dirname(resolved);
    return null;
  } catch {
    return null;
  }
}

function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    try {
      if (fs.existsSync(path.join(current, ".git"))) return current;
    } catch {
      return null;
    }
    const parent = path.dirname(current);
    if (samePath(parent, current)) return null;
    current = parent;
  }
}

function directoriesFromRootToCwd(rootDir, cwd) {
  const dirs = [];
  let current = path.resolve(cwd);
  while (true) {
    dirs.unshift(current);
    if (samePath(current, rootDir)) break;
    const parent = path.dirname(current);
    if (samePath(parent, current)) return [];
    current = parent;
  }
  return dirs;
}

function readInstructionFile(filePath) {
  try {
    return { content: fs.readFileSync(filePath, "utf-8") };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return { error: err?.message || String(err) };
  }
}

export function collectWorkspaceInstructionFiles({ cwd, workspaceContext } = {}) {
  const config = workspaceContext && typeof workspaceContext === "object" ? workspaceContext : {};
  const enabled = new Set();
  for (const item of WORKSPACE_INSTRUCTION_FILES) {
    if (config[item.key] === true) enabled.add(item.filename);
  }
  if (enabled.size === 0) return [];

  const startDir = existingDirectory(cwd);
  if (!startDir) return [];

  const gitRoot = findGitRoot(startDir);
  const searchRoot = gitRoot || startDir;
  const dirs = directoriesFromRootToCwd(searchRoot, startDir);
  const files = [];
  for (const dir of dirs) {
    for (const item of WORKSPACE_INSTRUCTION_FILES) {
      if (!enabled.has(item.filename)) continue;
      const filePath = path.join(dir, item.filename);
      const result = readInstructionFile(filePath);
      if (!result) continue;
      files.push({
        path: filePath,
        filename: item.filename,
        ...result,
      });
    }
  }
  return files;
}

export function formatWorkspaceInstructionFiles(files) {
  const items = Array.isArray(files) ? files : [];
  if (items.length === 0) return "";
  const body = items.map((file) => {
    const content = typeof file.content === "string"
      ? file.content.trim()
      : `Could not read this file: ${file.error || "unknown error"}`;
    return [
      `### ${file.filename || path.basename(file.path || "")}`,
      file.path ? `Path: ${file.path}` : "",
      "",
      content,
    ].filter((line, index) => index !== 1 || line).join("\n");
  }).join("\n\n");

  return [
    "## Workspace Instructions",
    "",
    "The following content comes from AGENTS.md / CLAUDE.md files in the current working-directory chain. Treat them as project-level working rules for this workspace context.",
    "",
    body,
  ].join("\n");
}
