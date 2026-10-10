/**
  *
  * */

import fs from "fs";
import path from "path";
import { sanitizePublicMediaUrl } from "../../shared/filename-sanitizer.ts";

//

let _allowedRoots = [];

/**
  * */
export function setMediaLocalRoots(roots) {
  _allowedRoots = (roots || []).filter(Boolean).map((r) => {
    const resolved = path.resolve(r);
    try { return fs.realpathSync(resolved); }
    catch { return resolved; }
  });
}

function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  return _allowedRoots.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
}

export function resolveAllowedLocalPath(filePath) {
  const localPath = String(filePath || "").startsWith("file://") ? fileUrlToPath(filePath) : filePath;
  if (!path.isAbsolute(localPath)) {
    throw new Error(`unsupported media source: ${String(filePath || "").slice(0, 30)}`);
  }
  let realPath;
  try { realPath = fs.realpathSync(localPath); }
  catch { throw new Error(`file not found: ${localPath}`); }
  if (!isPathAllowed(realPath)) {
    throw new Error("path outside allowed roots");
  }
  return realPath;
}

//

/**
 * 下载媒体资源，返-Buffer- * 支持 http:// / https:// / data: / 本地路径（需在白名单内）- */
export async function downloadMedia(url) {
 //
  if (url.startsWith("//")) url = "https:" + url;
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("invalid data URI");
    return Buffer.from(url.slice(comma + 1), "base64");
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
 //
    const chunks = [];
    for await (const chunk of resp.body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
 // 本地路径（file:// URI 或绝对路径）
  const localPath = url.startsWith("file://") ? fileUrlToPath(url) : url;
  if (path.isAbsolute(localPath)) {
 //
    const realPath = resolveAllowedLocalPath(localPath);
 //
    const stat = fs.statSync(realPath);
    if (stat.size > 50 * 1024 * 1024) {
      throw new Error(`file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    }
    return fs.readFileSync(realPath);
  }
  throw new Error(`unsupported media source: ${url.slice(0, 30)}`);
}

/** */
function fileUrlToPath(fileUrl) {
  try {
    const u = new URL(fileUrl);
 // Windows: pathname = "/C:/Users/..." -去掉前导 /
    const p = u.pathname;
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  } catch { return fileUrl.replace(/^file:\/\//, ""); }
}

/**
  * */
export function bufferToBase64(buffer) {
  return buffer.toString("base64");
}

//

const MAGIC_TABLE = [
  { bytes: [0xFF, 0xD8, 0xFF],                         mime: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4E, 0x47],                   mime: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38],                   mime: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46],                   mime: "image/webp", offset: 8, extra: [0x57, 0x45, 0x42, 0x50] },
  { bytes: [0x25, 0x50, 0x44, 0x46],                   mime: "application/pdf" },
  { bytes: [0x49, 0x44, 0x33],                         mime: "audio/mpeg" },
  { bytes: [0x4F, 0x67, 0x67, 0x53],                   mime: "audio/ogg" },
  { bytes: [0x00, 0x00, 0x00],                         mime: "video/mp4", minLen: 8, check: (b) => b.length >= 8 && (b.toString("ascii", 4, 8) === "ftyp") },
];

/** */
const EXT_MIME = {
  txt: "text/plain", md: "text/markdown", json: "application/json",
  csv: "text/csv", xml: "text/xml", html: "text/html", htm: "text/html",
  svg: "image/svg+xml", yml: "text/yaml", yaml: "text/yaml",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
};

/**
  *
 * @param {string} [fallback]
  * */
export function detectMime(buffer, fallback, filename) {
  for (const entry of MAGIC_TABLE) {
    if (buffer.length < entry.bytes.length) continue;
    const match = entry.bytes.every((b, i) => buffer[i] === b);
    if (!match) continue;
    if (entry.extra) {
      const off = entry.offset || 0;
      if (buffer.length < off + entry.extra.length) continue;
      if (!entry.extra.every((b, i) => buffer[off + i] === b)) continue;
    }
    if (entry.check && !entry.check(buffer)) continue;
    return entry.mime;
  }
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  }
  return fallback || "application/octet-stream";
}

//

const MEDIA_LINE_RE = /^MEDIA:\s*<?(.+?)>?\s*$/;
const IMG_MD_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/;

/**
 * 对标 OpenClaw splitMediaFromOutput()
 *
 * 提取规则（按优先级）- * 1. MEDIA:<url> 指令行（主协议，不区分媒体类型）
  *
 *
 * @param {string} text
 * @returns {{ text: string, mediaUrls: string[] }}
 */
export function splitMediaFromOutput(text) {
  const mediaUrls = [];
  const outputLines = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    //
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      outputLines.push(line);
      continue;
    }

    if (inFence) {
      outputLines.push(line);
      continue;
    }

    //
    const mediaMatch = MEDIA_LINE_RE.exec(line.trim());
    if (mediaMatch) {
      const url = mediaMatch[1];
      if (isValidMediaSource(url)) {
        mediaUrls.push(url);
      }
 // 无论是否有效都从输出中移除（不泄漏）
      continue;
    }

 // 2. ![alt](url) markdown 图片（弱 fallback，只从独立行提取-
    const imgMatch = IMG_MD_RE.exec(line);
    if (imgMatch && line.trim() === imgMatch[0]) {
 // 整行就是丢个图片标-
      if (isValidMediaSource(imgMatch[1])) {
        mediaUrls.push(imgMatch[1]);
      }
      continue;
    }

    outputLines.push(line);
  }

  return {
    text: outputLines.join("\n").trim(),
    mediaUrls,
  };
}

function isValidMediaSource(url) {
  if (isExtractableReplyMediaSource(url)) return true;
  // HTTP(S) URL
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
    if (u.protocol === "file:") return isPathAllowed(fileUrlToPath(url));
  } catch { /* 不是合法 URL，检查是否为绝对路径 */ }
 // 绝对本地路径
  if (path.isAbsolute(url)) return isPathAllowed(url);
  return false;
}

export function isExtractableReplyMediaSource(url) {
  return !!sanitizePublicMediaUrl(url);
}

// ── 工具函数 ────────────────────────────────────────────

/**
  *
 */
export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
  * */
export function formatSize(bytes) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
