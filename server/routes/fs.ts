/**
 * File-system API for web clients.
 *
 * Electron uses IPC for these operations. Web/cloud clients use these HTTP
 * endpoints. Paths are restricted to the app data directory and the active
 * desk workspace.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { xlsxToHtml } from "../../shared/xlsx-utils.ts";
import { parseDesignDocumentPreview } from "../../shared/design-document-preview.ts";
import { safeJson } from "../hono-helpers.ts";
import { resolveAgent } from "../utils/resolve-agent.ts";

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;

function comparePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideRoot(candidatePath, rootPath) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  if (comparePath(candidate) === comparePath(root)) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveAllowedPath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);

  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    if (!isInsideRoot(resolved, resolvedRoot)) continue;

    let realRoot = null;
    try {
      realRoot = fs.realpathSync(resolvedRoot);
    } catch {
      continue;
    }

    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) return null;
      const realPath = fs.realpathSync(resolved);
      return isInsideRoot(realPath, realRoot) ? realPath : null;
    } catch (err) {
      if (err?.code !== "ENOENT") return null;
      try {
        const realParent = fs.realpathSync(path.dirname(resolved));
        return isInsideRoot(realParent, realRoot) ? resolved : null;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function versionsEqual(a, b) {
  if (!a || !b) return false;
  if (typeof a.sha256 === "string" && typeof b.sha256 === "string") {
    return a.sha256 === b.sha256 && a.size === b.size;
  }
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function readTextFileSnapshot(filePath, { maxBytes = MAX_TEXT_FILE_BYTES } = {}) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  if (stat.size > maxBytes) return null;

  const buf = fs.readFileSync(filePath);
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return null;

  return {
    content: buf.toString("utf-8"),
    version: {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: hashBuffer(buf),
    },
  };
}

function writeTextFileIfUnchanged(filePath, content, expectedVersion) {
  if (expectedVersion) {
    const current = readTextFileSnapshot(filePath);
    if (!current || !versionsEqual(current.version, expectedVersion)) {
      return {
        ok: false,
        conflict: true,
        version: current?.version ?? null,
      };
    }
  }

  fs.writeFileSync(filePath, content, "utf-8");
  const next = readTextFileSnapshot(filePath);
  return {
    ok: true,
    conflict: false,
    version: next?.version ?? null,
  };
}

function scanSkillDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".") && !entry.isSymbolicLink())
    .sort((a, b) => {
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory()
        ? { name: entry.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath) }
        : { name: entry.name, path: fullPath, isDir: false };
    });
}

function addRoot(roots, value) {
  if (typeof value === "string" && value.trim()) roots.add(path.resolve(value));
}

export function createFsRoute(engine) {
  const route = new Hono();
  const codiaHome = path.resolve(engine.codiaHome);

  function getAllowedRoots(c) {
    const roots = new Set([codiaHome]);
    addRoot(roots, engine.defaultDeskCwd);
    addRoot(roots, engine.homeCwd);
    addRoot(roots, engine.deskCwd);

    if (typeof engine.getSessionWorkspaceFolders === "function") {
      for (const root of engine.getSessionWorkspaceFolders(engine.currentSessionPath) || []) {
        addRoot(roots, root);
      }
    }

    for (const root of Array.isArray(engine.config?.cwd_history) ? engine.config.cwd_history : []) {
      addRoot(roots, root);
    }

    try {
      const deskManager = resolveAgent(engine, c)?.deskManager;
      addRoot(roots, deskManager?.deskDir);
      addRoot(roots, deskManager?.homePath);
    } catch {
      // File access can still be valid for app/workspace roots without an active agent.
    }

    return Array.from(roots);
  }

  function resolveRequestPath(c, filePath) {
    if (!filePath) return { error: c.json({ error: "missing path" }, 400) };
    const allowedPath = resolveAllowedPath(filePath, getAllowedRoots(c));
    if (!allowedPath) return { error: c.json({ error: "path not allowed" }, 403) };
    return { allowedPath };
  }

  route.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      const snapshot = readTextFileSnapshot(resolved.allowedPath);
      if (!snapshot) return c.json({ error: "file not readable" }, 400);
      return c.text(snapshot.content);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "file read failed" }, 500);
    }
  });

  route.get("/fs/read-snapshot", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      const snapshot = readTextFileSnapshot(resolved.allowedPath);
      if (!snapshot) return c.json({ error: "file not readable" }, 400);
      return c.json(snapshot);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "file read failed" }, 500);
    }
  });

  route.get("/fs/read-base64", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      const stat = fs.statSync(resolved.allowedPath);
      if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
      if (stat.size > MAX_BINARY_FILE_BYTES) return c.json({ error: "file too large" }, 413);
      const buf = fs.readFileSync(resolved.allowedPath);
      return c.text(buf.toString("base64"));
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  route.get("/fs/docx-html", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      const stat = fs.statSync(resolved.allowedPath);
      if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
      if (stat.size > MAX_BINARY_FILE_BYTES) return c.json({ error: "file too large" }, 413);
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.convertToHtml({ path: resolved.allowedPath });
      return c.text(result.value);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "docx parse failed" }, 500);
    }
  });

  route.get("/fs/xlsx-html", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      const stat = fs.statSync(resolved.allowedPath);
      if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
      if (stat.size > MAX_BINARY_FILE_BYTES) return c.json({ error: "file too large" }, 413);
      const html = await xlsxToHtml(resolved.allowedPath);
      if (html == null) return c.json({ error: "empty workbook" }, 400);
      return c.text(html);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "xlsx parse failed" }, 500);
    }
  });

  route.get("/fs/design-preview", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      return c.json(await parseDesignDocumentPreview(resolved.allowedPath));
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      if (err?.code === "DESIGN_PREVIEW_FILE_TOO_LARGE") return c.json({ error: "file too large" }, 413);
      if (err?.code === "DESIGN_PREVIEW_UNSUPPORTED") return c.json({ error: "unsupported design document" }, 415);
      if (err?.code === "DESIGN_PREVIEW_NOT_FILE") return c.json({ error: "not a file" }, 400);
      return c.json({ error: "design preview failed" }, 500);
    }
  });

  route.post("/fs/write", async (c) => {
    const body = await safeJson(c);
    const resolved = resolveRequestPath(c, body.path);
    if (resolved.error) return resolved.error;
    if (typeof body.content !== "string") return c.json({ error: "content must be a string" }, 400);
    if (Buffer.byteLength(body.content, "utf-8") > MAX_TEXT_FILE_BYTES) {
      return c.json({ error: "file too large" }, 413);
    }
    try {
      fs.writeFileSync(resolved.allowedPath, body.content, "utf-8");
      const snapshot = readTextFileSnapshot(resolved.allowedPath);
      return c.json({ ok: true, version: snapshot?.version ?? null });
    } catch {
      return c.json({ ok: false }, 500);
    }
  });

  route.post("/fs/write-if-unchanged", async (c) => {
    const body = await safeJson(c);
    const resolved = resolveRequestPath(c, body.path);
    if (resolved.error) return resolved.error;
    if (typeof body.content !== "string") return c.json({ ok: false, error: "content must be a string" }, 400);
    if (Buffer.byteLength(body.content, "utf-8") > MAX_TEXT_FILE_BYTES) {
      return c.json({ ok: false, error: "file too large" }, 413);
    }
    try {
      return c.json(writeTextFileIfUnchanged(resolved.allowedPath, body.content, body.expectedVersion || null));
    } catch {
      return c.json({ ok: false }, 500);
    }
  });

  route.post("/fs/write-binary", async (c) => {
    const body = await safeJson(c);
    const resolved = resolveRequestPath(c, body.path);
    if (resolved.error) return resolved.error;
    if (typeof body.base64Data !== "string") return c.json({ ok: false, error: "base64Data must be a string" }, 400);
    try {
      const buf = Buffer.from(body.base64Data, "base64");
      if (!buf.length || buf.length > MAX_BINARY_FILE_BYTES) {
        return c.json({ ok: false, error: "file too large" }, 413);
      }
      fs.mkdirSync(path.dirname(resolved.allowedPath), { recursive: true });
      fs.writeFileSync(resolved.allowedPath, buf);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 500);
    }
  });

  route.post("/fs/delete", async (c) => {
    const body = await safeJson(c);
    const resolved = resolveRequestPath(c, body.path);
    if (resolved.error) return resolved.error;
    try {
      fs.lstatSync(resolved.allowedPath);
      fs.rmSync(resolved.allowedPath, { recursive: true, force: true });
      return c.json({ ok: true });
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ ok: false, error: "file not found" }, 404);
      return c.json({ ok: false }, 500);
    }
  });

  route.get("/fs/list-skill-files", async (c) => {
    const baseDir = c.req.query("baseDir");
    const resolved = resolveRequestPath(c, baseDir);
    if (resolved.error) return resolved.error;
    try {
      const stat = fs.statSync(resolved.allowedPath);
      if (!stat.isDirectory()) return c.json({ files: [] });
      return c.json({ files: scanSkillDir(resolved.allowedPath) });
    } catch {
      return c.json({ files: [] });
    }
  });

  route.get("/fs/read-skill-file", async (c) => {
    const filePath = c.req.query("path");
    const resolved = resolveRequestPath(c, filePath);
    if (resolved.error) return resolved.error;
    try {
      const snapshot = readTextFileSnapshot(resolved.allowedPath, { maxBytes: MAX_SKILL_FILE_BYTES });
      if (!snapshot) return c.json({ error: "file not readable" }, 400);
      return c.text(snapshot.content);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "file read failed" }, 500);
    }
  });

  return route;
}
