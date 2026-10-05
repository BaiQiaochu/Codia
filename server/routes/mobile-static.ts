import fs from "fs";
import path from "path";
import { Hono } from "hono";

const MIME_BY_EXT = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function createMobileStaticRoute({ distDir }: { distDir?: string } = {}) {
  if (!distDir) throw new Error("distDir required");
  const route = new Hono();

  registerMobileStaticAlias(route, distDir, "/mobile");
  registerMobileStaticAlias(route, distDir, "/desktop");

  return route;
}

function registerMobileStaticAlias(route: Hono, distDir: string, basePath: string) {
  const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripBase = new RegExp(`^${escapedBase}\\/?`);
  route.get(basePath, (c) => serveMobileFile(c, distDir, ""));
  route.get(`${basePath}/`, (c) => serveMobileFile(c, distDir, ""));
  route.get(`${basePath}/*`, (c) => serveMobileFile(c, distDir, c.req.path.replace(stripBase, "")));
}

function serveMobileFile(c: any, distDir: string, requestPath: string) {
  const relative = requestPath ? safeRelativePath(requestPath) : "mobile.html";
  if (!relative) return c.body(null, 404);
  const filePath = path.join(distDir, relative);
  const safePath = resolveExistingInside(distDir, filePath);
  if (!safePath) return c.body(null, 404);
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) return c.body(null, 404);
  c.header("Content-Type", guessMime(safePath));
  c.header("Cache-Control", relative === "mobile.html"
    ? "no-cache"
    : "public, max-age=31536000, immutable");
  return c.body(fs.readFileSync(safePath));
}

function safeRelativePath(value: unknown): string | null {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ""));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0")) return null;
  const parts = decoded.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (
    parts[0] !== "assets"
    && parts[0] !== "icons"
    && parts[0] !== "lib"
    && parts[0] !== "themes"
    && parts[0] !== "locales"
    && decoded !== "styles.css"
    && decoded !== "manifest.webmanifest"
    && decoded !== "sw.js"
    && decoded !== "icon.png"
  ) {
    return null;
  }
  return parts.join(path.sep);
}

function resolveExistingInside(root: string, target: string): string | null {
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

function guessMime(filePath: string): string {
  return MIME_BY_EXT.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}
