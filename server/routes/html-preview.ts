import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { guessMime } from "../http/file-content.ts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 50 * 1024 * 1024;

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
  "connect-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "font-src https: data:",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: data: blob:",
  "frame-ancestors 'self' file: http://127.0.0.1:* http://localhost:*",
].join("; ");

export function createHtmlPreviewRoute({
  ttlMs = DEFAULT_TTL_MS,
  maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
  maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
  now = () => Date.now(),
  randomId = () => `pv_${crypto.randomBytes(16).toString("hex")}`,
  randomToken = () => crypto.randomBytes(32).toString("base64url"),
} = {}) {
  const route = new Hono();
  const previews = new Map();

  route.post("/api/preview/html", async (c) => {
    cleanupExpired(previews, now());

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const content = typeof body?.content === "string" ? body.content : null;
    if (content === null) return c.json({ error: "missing_content" }, 400);
    if (Buffer.byteLength(content, "utf-8") > maxContentBytes) {
      return c.json({ error: "html_preview_too_large" }, 413);
    }

    const id = randomId();
    const token = randomToken();
    const sourceScope = resolvePreviewSourceScope(body?.sourceFilePath, body?.sandboxRoot);
    const requestUrl = new URL(c.req.url);
    const assetBaseUrl = sourceScope
      ? new URL(`/preview/html/${encodeURIComponent(id)}/assets/${encodeURIComponent(token)}/`, requestUrl.origin).toString()
      : null;
    const servedContent = assetBaseUrl ? injectAssetBase(content, assetBaseUrl) : content;
    const expiresAt = now() + ttlMs;
    previews.set(id, {
      token,
      content: servedContent,
      title: typeof body?.title === "string" ? body.title.slice(0, 240) : "",
      sourceDir: sourceScope?.sourceDir || null,
      assetRoot: sourceScope?.assetRoot || null,
      allowParentSegments: sourceScope?.allowParentSegments === true,
      expiresAt,
    });

    const previewUrl = new URL(`/preview/html/${encodeURIComponent(id)}`, requestUrl.origin);
    previewUrl.searchParams.set("previewToken", token);

    return c.json({
      id,
      previewUrl: previewUrl.toString(),
      expiresAt,
    });
  });

  route.get("/preview/html/:id", (c) => servePreview(c, previews, now()));
  route.on("HEAD", "/preview/html/:id", (c) => servePreview(c, previews, now(), true));
  route.get("/preview/html/:id/assets/:token/*", (c) => servePreviewAsset(c, previews, now(), maxAssetBytes));
  route.on("HEAD", "/preview/html/:id/assets/:token/*", (c) => servePreviewAsset(c, previews, now(), maxAssetBytes, true));

  return route;
}

function servePreview(c, previews, currentTime, headOnly = false) {
  cleanupExpired(previews, currentTime);

  const id = c.req.param("id");
  const token = c.req.query("previewToken") || "";
  const preview = previews.get(id);
  if (!preview || preview.token !== token) {
    return c.body(null, 404);
  }

  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Content-Security-Policy", HTML_PREVIEW_CSP);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("Cross-Origin-Resource-Policy", "cross-origin");

  return c.body(headOnly ? null : preview.content);
}

function servePreviewAsset(c, previews, currentTime, maxAssetBytes, headOnly = false) {
  cleanupExpired(previews, currentTime);

  const id = c.req.param("id");
  const token = c.req.param("token") || "";
  const preview = previews.get(id);
  if (!preview || preview.token !== token || !preview.sourceDir || !preview.assetRoot) {
    return c.body(null, 404);
  }

  const relativePath = extractAssetPath(c.req.path, id, token);
  const assetPath = resolveAssetPath(preview.sourceDir, preview.assetRoot, relativePath, {
    allowParentSegments: preview.allowParentSegments,
  });
  if (!assetPath) return c.body(null, 404);

  const stat = fs.statSync(assetPath);
  if (!stat.isFile() || stat.size > maxAssetBytes) return c.body(null, 404);

  c.header("Content-Type", guessMime(assetPath));
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  return c.body(headOnly ? null : fs.readFileSync(assetPath));
}

function cleanupExpired(previews, currentTime) {
  for (const [id, preview] of previews.entries()) {
    if (preview.expiresAt <= currentTime) previews.delete(id);
  }
}

function resolvePreviewSourceScope(sourceFilePath, sandboxRoot) {
  if (typeof sourceFilePath !== "string" || !path.isAbsolute(sourceFilePath)) return null;
  try {
    const stat = fs.statSync(sourceFilePath);
    if (!stat.isFile()) return null;
    const sourceDir = fs.realpathSync(path.dirname(sourceFilePath));
    if (typeof sandboxRoot !== "string" || !path.isAbsolute(sandboxRoot)) {
      return { sourceDir, assetRoot: sourceDir, allowParentSegments: false };
    }
    const realSandboxRoot = fs.realpathSync(sandboxRoot);
    if (!isInsideRoot(sourceDir, realSandboxRoot)) {
      return { sourceDir, assetRoot: sourceDir, allowParentSegments: false };
    }
    return { sourceDir, assetRoot: realSandboxRoot, allowParentSegments: true };
  } catch {
    return null;
  }
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function injectAssetBase(content, assetBaseUrl) {
  const baseTag = `<base href="${escapeHtmlAttr(assetBaseUrl)}">`;
  if (/<head\b[^>]*>/i.test(content)) {
    return content.replace(/<head\b[^>]*>/i, (match) => `${match}${baseTag}`);
  }
  return `${baseTag}${content}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAssetPath(requestPath, id, token) {
  const prefix = new RegExp(`^/preview/html/${escapeRegExp(id)}/assets/${escapeRegExp(token)}/?`);
  const raw = String(requestPath || "").replace(prefix, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function isInsideRoot(candidatePath, rootPath) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

function resolveAssetPath(sourceDir, assetRoot, relativePath, { allowParentSegments = false } = {}) {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\")) return null;
  if (path.isAbsolute(relativePath)) return null;
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || (!allowParentSegments && part === ".."))) return null;

  const candidate = path.resolve(sourceDir, relativePath);
  if (!isInsideRoot(candidate, assetRoot)) return null;

  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return null;
    const realPath = fs.realpathSync(candidate);
    if (!isInsideRoot(realPath, assetRoot)) return null;
    return realPath;
  } catch {
    return null;
  }
}
