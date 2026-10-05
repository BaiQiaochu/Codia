// @ts-nocheck
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { extractZip } from "../extract-zip.ts";
import { safeCopyDir } from "../../shared/safe-fs.ts";
import { parseSkillMetadata } from "./skill-metadata.ts";
import { createSkillSourceIdentity } from "./skill-file-identity.ts";

const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class SkillInstallError extends Error {
  constructor(message, { code = "SKILL_INSTALL_FAILED", status = 400 } = {}) {
    super(message);
    this.name = "SkillInstallError";
    this.code = code;
    this.status = status;
  }
}

export function sanitizeSkillName(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!SAFE_SKILL_NAME.test(trimmed)) return null;
  return trimmed;
}

function makeTempDir(parentDir, prefix) {
  fs.mkdirSync(parentDir, { recursive: true });
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = path.join(parentDir, `.${prefix}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ }
}

function visibleSubdirectories(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function pathCandidates(rootDir, subpath = "") {
  const normalizedSubpath = String(subpath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const candidates = [];
  if (normalizedSubpath) {
    candidates.push(path.join(rootDir, normalizedSubpath));
    for (const name of visibleSubdirectories(rootDir)) {
      candidates.push(path.join(rootDir, name, normalizedSubpath));
    }
    return candidates;
  }
  candidates.push(rootDir);
  for (const name of visibleSubdirectories(rootDir)) {
    candidates.push(path.join(rootDir, name));
  }
  return candidates;
}

export function findSkillPackageRoot(rootDir, { subpath = "" } = {}) {
  for (const candidate of pathCandidates(rootDir, subpath)) {
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) {
      return candidate;
    }
  }
  return null;
}

export function readSkillName(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, "utf-8");
  const meta = parseSkillMetadata(content, "");
  return typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : null;
}

function escapeYamlScalar(value) {
  const text = String(value);
  return SAFE_SKILL_NAME.test(text) ? text : JSON.stringify(text);
}

function upsertFrontmatterLine(frontmatter, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`(^|\\r?\\n)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*.*(?=\\r?\\n|$)`, "m");
  if (re.test(frontmatter)) {
    return frontmatter.replace(re, (match, prefix = "") => `${prefix}${line}`);
  }
  const trimmed = frontmatter.replace(/\s*$/, "");
  return `${trimmed}${trimmed ? "\n" : ""}${line}`;
}

export function rewriteSkillInstallMetadata(content, skillName, { defaultEnabled } = {}) {
  const body = typeof content === "string" ? content : "";
  const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(\r?\n|$)([\s\S]*)$/);
  const lines = [`name: ${escapeYamlScalar(skillName)}`];
  if (typeof defaultEnabled === "boolean") {
    lines.push(`default-enabled: ${defaultEnabled ? "true" : "false"}`);
  }

  if (!match) {
    return ["---", ...lines, "---", "", body].join("\n");
  }

  let frontmatter = match[1] || "";
  frontmatter = upsertFrontmatterLine(frontmatter, "name", escapeYamlScalar(skillName));
  if (typeof defaultEnabled === "boolean") {
    frontmatter = upsertFrontmatterLine(frontmatter, "default-enabled", defaultEnabled ? "true" : "false");
  }
  return `---\n${frontmatter}\n---${match[2] || "\n"}${match[3] || ""}`;
}

function assertNoSymlinkEntries(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new SkillInstallError(`skill package cannot contain symlink: ${fullPath}`, {
        code: "SKILL_PACKAGE_SYMLINK",
      });
    }
    if (stat.isDirectory()) {
      assertNoSymlinkEntries(fullPath);
    }
  }
}

function assertInstallTargetInsideRoot(targetDir, installDir) {
  const root = path.resolve(installDir);
  const target = path.resolve(targetDir);
  if (target !== root && target.startsWith(root + path.sep)) return;
  throw new SkillInstallError(`invalid skill install target: ${targetDir}`, {
    code: "SKILL_INSTALL_TARGET_OUTSIDE_ROOT",
  });
}

export function installSkillPackageFromDirectory({
  sourceDir,
  installDir,
  owner = "user",
  subpath = "",
  defaultEnabled,
} = {}) {
  if (!sourceDir || !installDir) {
    throw new SkillInstallError("sourceDir and installDir are required", {
      code: "SKILL_INSTALL_MISSING_PATH",
    });
  }
  const skillDir = findSkillPackageRoot(sourceDir, { subpath });
  if (!skillDir) {
    throw new SkillInstallError("skill package missing SKILL.md", {
      code: "SKILL_MISSING_SKILL_MD",
    });
  }

  assertNoSymlinkEntries(skillDir);

  const rawName = readSkillName(path.join(skillDir, "SKILL.md"));
  if (!rawName) {
    throw new SkillInstallError("skill package missing frontmatter name", {
      code: "SKILL_MISSING_NAME",
    });
  }

  const safeName = sanitizeSkillName(rawName);
  if (!safeName) {
    throw new SkillInstallError(`invalid skill name: ${rawName}`, {
      code: "SKILL_INVALID_NAME",
    });
  }

  fs.mkdirSync(installDir, { recursive: true });
  const dstDir = path.join(installDir, safeName);
  assertInstallTargetInsideRoot(dstDir, installDir);
  safeCopyDir(skillDir, dstDir);

  const skillFilePath = path.join(dstDir, "SKILL.md");
  if (typeof defaultEnabled === "boolean" || safeName !== rawName) {
    const content = fs.readFileSync(skillFilePath, "utf-8");
    fs.writeFileSync(
      skillFilePath,
      rewriteSkillInstallMetadata(content, safeName, { defaultEnabled }),
      "utf-8",
    );
  }

  return {
    name: safeName,
    dir: dstDir,
    filePath: skillFilePath,
    installedSkillSource: createSkillSourceIdentity({
      owner,
      skillName: safeName,
      filePath: skillFilePath,
      baseDir: dstDir,
    }),
  };
}

export async function installSkillPackageFromPath({
  sourcePath,
  installDir,
  owner = "user",
  defaultEnabled,
} = {}) {
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new SkillInstallError("skill source path must be absolute", {
      code: "SKILL_SOURCE_MUST_BE_ABSOLUTE",
    });
  }
  if (!fs.existsSync(sourcePath)) {
    throw new SkillInstallError("skill source path does not exist", {
      code: "SKILL_SOURCE_NOT_FOUND",
    });
  }

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return installSkillPackageFromDirectory({
      sourceDir: sourcePath,
      installDir,
      owner,
      defaultEnabled,
    });
  }

  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== ".zip" && ext !== ".skill") {
    throw new SkillInstallError("unsupported skill package format", {
      code: "SKILL_UNSUPPORTED_FORMAT",
    });
  }

  const tmpDir = makeTempDir(installDir, "tmp-install");
  try {
    await extractZip(sourcePath, tmpDir);
    return installSkillPackageFromDirectory({
      sourceDir: tmpDir,
      installDir,
      owner,
      defaultEnabled,
    });
  } finally {
    cleanupDir(tmpDir);
  }
}

export async function installSkillPackageFromContent({
  content,
  skillName,
  installDir,
  owner = "user",
  defaultEnabled,
} = {}) {
  const safeName = sanitizeSkillName(skillName);
  if (!safeName) {
    throw new SkillInstallError(`invalid skill name: ${skillName || ""}`, {
      code: "SKILL_INVALID_NAME",
    });
  }
  const tmpDir = makeTempDir(installDir, "tmp-install-content");
  try {
    const skillDir = path.join(tmpDir, safeName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      rewriteSkillInstallMetadata(content, safeName, { defaultEnabled }),
      "utf-8",
    );
    return installSkillPackageFromDirectory({
      sourceDir: skillDir,
      installDir,
      owner,
      defaultEnabled,
    });
  } finally {
    cleanupDir(tmpDir);
  }
}

export async function prepareGithubSkillPackage({
  owner,
  repo,
  subpath = "",
  installDir,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!owner || !repo || !installDir) {
    throw new SkillInstallError("owner, repo and installDir are required", {
      code: "SKILL_GITHUB_MISSING_INPUT",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new SkillInstallError("fetch is unavailable", {
      code: "SKILL_GITHUB_FETCH_UNAVAILABLE",
    });
  }

  const tmpDir = makeTempDir(installDir, "tmp-github-skill");
  const zipPath = path.join(tmpDir, "source.zip");
  const extractDir = path.join(tmpDir, "source");
  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/zip/HEAD`;
  try {
    const response = await fetchImpl(archiveUrl, {
      headers: { "User-Agent": "GSAPBot/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new SkillInstallError(`GitHub archive download failed: ${response.status}`, {
        code: "SKILL_GITHUB_ARCHIVE_FAILED",
      });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(zipPath, bytes);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);
    const skillDir = findSkillPackageRoot(extractDir, { subpath });
    if (!skillDir) {
      throw new SkillInstallError("GitHub archive does not contain SKILL.md", {
        code: "SKILL_MISSING_SKILL_MD",
      });
    }
    return {
      sourceDir: extractDir,
      skillDir,
      skillFilePath: path.join(skillDir, "SKILL.md"),
      fetchedFrom: archiveUrl,
      cleanup: () => cleanupDir(tmpDir),
    };
  } catch (err) {
    cleanupDir(tmpDir);
    throw err;
  }
}
