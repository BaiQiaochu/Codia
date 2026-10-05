// @ts-nocheck
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { fromRoot } from "../../shared/app-root.ts";

const MIME_BY_EXT = new Map([
  [".tar", "application/x-tar"],
  [".wasm", "application/wasm"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

export function resolveOcrRuntimeDir({
  runtimeDir,
  appRoot = fromRoot(),
  env = process.env,
  existsSync = fs.existsSync,
  cwd = process.cwd(),
} = {}) {
  if (runtimeDir) return path.resolve(runtimeDir);

  const candidates = [
    env.GSAP_OCR_RUNTIME_ROOT,
    path.join(appRoot, "vendor", "ocr-runtime"),
    path.join(appRoot, "..", "ocr-runtime"),
    path.join(cwd, "vendor", "ocr-runtime"),
    path.join(cwd, "ocr-runtime"),
  ].filter(Boolean);

  return path.resolve(candidates.find((candidate) => existsSync(candidate)) || candidates[0]);
}

export function createOcrRuntimeRoute({ runtimeDir = resolveOcrRuntimeDir() } = {}) {
  if (!runtimeDir) throw new Error("runtimeDir required");
  const route = new Hono();

  route.get("/ocr-runtime/*", (c) => serveOcrRuntimeFile(c, runtimeDir, false));
  route.on("HEAD", "/ocr-runtime/*", (c) => serveOcrRuntimeFile(c, runtimeDir, true));

  return route;
}

function serveOcrRuntimeFile(c, runtimeDir, headOnly) {
  const relative = safeRelativePath(c.req.path.replace(/^\/ocr-runtime\/?/, ""));
  if (!relative) return c.body(null, 404);

  const filePath = path.join(runtimeDir, relative);
  const safePath = resolveExistingInside(runtimeDir, filePath);
  if (!safePath) return c.body(null, 404);

  const stat = fs.statSync(safePath);
  if (!stat.isFile()) return c.body(null, 404);

  c.header("Content-Type", guessMime(safePath));
  c.header("Content-Length", String(stat.size));
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  if (headOnly) return c.body(null, 200);
  return c.body(fs.readFileSync(safePath), 200);
}

function safeRelativePath(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ""));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0")) return null;
  const parts = decoded.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts[0] !== "models" && parts[0] !== "ort") return null;
  return parts.join(path.sep);
}

function resolveExistingInside(root, target) {
  let rootReal;
  let targetReal;
  try {
    rootReal = fs.realpathSync(root);
    targetReal = fs.realpathSync(target);
  } catch {
    return null;
  }
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)
    ? targetReal
    : null;
}

function guessMime(filePath) {
  return MIME_BY_EXT.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}
