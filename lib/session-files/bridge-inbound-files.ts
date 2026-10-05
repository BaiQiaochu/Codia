// @ts-nocheck
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { detectMime, extOfName } from "../file-metadata.ts";
import { serializeSessionFile } from "./session-file-response.ts";
import { sessionFilesCacheDir } from "./session-file-registry.ts";
import { sanitizePathBasename, uniqueFilename } from "../../shared/filename-sanitizer.ts";

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "application/pdf": "pdf",
};

export async function materializeBridgeInboundFiles({
  gsapHome,
  hanakoHome,
  sessionPath,
  files,
  registerSessionFile,
} = {}) {
  if (!files?.length) {
    return { sessionFiles: [], imageAttachmentPaths: [], displayAttachments: [] };
  }
  const home = gsapHome || hanakoHome;
  if (!home) throw new Error("bridge inbound file materialization requires gsapHome");
  if (!sessionPath) throw new Error("bridge inbound file materialization requires sessionPath");
  if (typeof registerSessionFile !== "function") {
    throw new Error("bridge inbound file materialization requires registerSessionFile");
  }

  const dir = sessionFilesCacheDir(home, sessionPath);
  await fs.mkdir(dir, { recursive: true });

  const sessionFiles = [];
  const imageAttachmentPaths = [];
  const displayAttachments = [];

  for (const file of files) {
    const buffer = toBuffer(file?.buffer);
    if (!buffer?.length) continue;
    const filename = safeFilename(file.filename, file.mimeType, file.type);
    const filePath = path.join(dir, uniqueName(filename));
    await fs.writeFile(filePath, buffer);

    const registered = serializeSessionFile(registerSessionFile({
      sessionPath,
      filePath,
      label: filename,
      origin: "bridge_inbound",
      storageKind: "managed_cache",
    }));
    if (!registered) continue;

    sessionFiles.push(registered);
    if (file.type === "image" || registered.kind === "image") {
      imageAttachmentPaths.push(filePath);
    }
    displayAttachments.push({
      fileId: registered.fileId || registered.id,
      path: filePath,
      name: filename,
      isDir: false,
      mimeType: registered.mime || file.mimeType || detectMime(buffer, "application/octet-stream", filename),
      status: registered.status,
      missingAt: registered.missingAt,
    });
  }

  return { sessionFiles, imageAttachmentPaths, displayAttachments };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "base64");
  return null;
}

function safeFilename(name, mimeType, type) {
  const fallback = `bridge-inbound.${extensionFor(mimeType, type)}`;
  const raw = typeof name === "string" && name.trim() ? name : fallback;
  const base = sanitizePathBasename(raw, { fallback });
  if (path.extname(base)) return base;
  return `${base}.${extensionFor(mimeType, type)}`;
}

function extensionFor(mimeType, type) {
  const normalized = String(mimeType || "").toLowerCase();
  if (MIME_EXTENSIONS[normalized]) return MIME_EXTENSIONS[normalized];
  if (type === "image") return "jpg";
  if (type === "video") return "mp4";
  if (type === "audio") return "ogg";
  return "bin";
}

function uniqueName(filename) {
  const safe = uniqueFilename(filename);
  const ext = extOfName(safe);
  const suffix = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  if (!ext) return `${safe}_${suffix}`;
  const dotted = `.${ext}`;
  return `${safe.slice(0, -dotted.length)}_${suffix}${dotted}`;
}
