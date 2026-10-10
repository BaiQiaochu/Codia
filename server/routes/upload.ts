// @ts-nocheck
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { isSensitivePath } from "../utils/path-security.ts";
import { isValidSessionPath } from "../../core/message-utils.ts";
import { registerSessionFileFromRequest } from "../../lib/session-files/session-file-response.ts";
import { sessionFilesCacheDir } from "../../lib/session-files/session-file-registry.ts";
import {
  MAX_CHAT_IMAGE_BASE64_CHARS,
  extensionFromChatImageMime,
  isAllowedChatImageMime,
  isChatImageBase64WithinLimit,
} from "../../shared/image-mime.ts";
import {
  MAX_CHAT_AUDIO_BASE64_CHARS,
  extensionFromChatAudioMime,
  isAllowedChatAudioMime,
  isAllowedUploadAudioMime,
  isChatAudioBase64WithinLimit,
} from "../../shared/audio-mime.ts";
import { sanitizePathBasename } from "../../shared/filename-sanitizer.ts";

const MAX_FILES = 9;
const MAX_KG_SYNC_TEXT_CHARS = 120_000;
const SESSION_FILE_PRESENTATIONS = new Set(["attachment", "voice-input"]);
const KG_SYNC_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".py",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
]);

class UploadPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadPathError";
  }
}

function extFromMime(mimeType) {
  return extensionFromChatImageMime(mimeType) || extensionFromChatAudioMime(mimeType);
}

function isAllowedUploadBlobMime(mimeType) {
  return isAllowedChatImageMime(mimeType) || isAllowedUploadAudioMime(mimeType);
}

function isUploadBlobBase64WithinLimit(base64Data, mimeType) {
  if (isAllowedChatImageMime(mimeType)) return isChatImageBase64WithinLimit(base64Data);
  if (isAllowedUploadAudioMime(mimeType)) return isChatAudioBase64WithinLimit(base64Data);
  return false;
}

function uploadBlobMaxBase64Chars(mimeType) {
  if (isAllowedUploadAudioMime(mimeType)) return MAX_CHAT_AUDIO_BASE64_CHARS;
  return MAX_CHAT_IMAGE_BASE64_CHARS;
}

function normalizeSessionFilePresentation(value) {
  if (value == null || value === "") return "attachment";
  if (typeof value !== "string") return null;
  return SESSION_FILE_PRESENTATIONS.has(value) ? value : null;
}

function originForPresentation(presentation) {
  return presentation === "voice-input" ? "voice_input" : "user_upload";
}

function listedForPresentation(presentation) {
  return presentation !== "voice-input";
}

function waveformForUploadPath(body, srcPath) {
  const metadataByPath = body?.metadataByPath;
  if (!metadataByPath || typeof metadataByPath !== "object" || Array.isArray(metadataByPath)) return undefined;
  const direct = metadataByPath[srcPath];
  if (!direct || typeof direct !== "object" || Array.isArray(direct)) return undefined;
  return direct.waveform;
}

function sanitizeBlobName(name, mimeType) {
  const fallbackBase = isAllowedChatAudioMime(mimeType) ? "recording" : "pasted";
  const fallback = `${fallbackBase}${extFromMime(mimeType) || ".bin"}`;
  if (!name || typeof name !== "string") return fallback;

  const base = sanitizePathBasename(name, { fallback });
  if (!base) return fallback;

  const want = extFromMime(mimeType);
  if (want && path.extname(base).toLowerCase() !== want) {
    return path.basename(base, path.extname(base)) + want;
  }
  return base;
}

export async function countFiles(targetPath, { limit = Infinity, seen = new Set() } = {}) {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    throw new UploadPathError("symlink not allowed");
  }
  if (!stat.isDirectory()) return 1;

  let realDir;
  try {
    realDir = await fs.realpath(targetPath);
  } catch {
    realDir = path.resolve(targetPath);
  }
  if (seen.has(realDir)) return 0;
  seen.add(realDir);

  let count = 0;
  const entries = await fs.readdir(targetPath);
  for (const entry of entries) {
    const remaining = limit - count;
    if (remaining <= 0) return limit + 1;
    count += await countFiles(path.join(targetPath, entry), { limit: remaining, seen });
    if (count > limit) return limit + 1;
  }
  return count;
}

async function cleanOldUploads(uploadsDir) {
  try {
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const fullPath = path.join(uploadsDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore entries that disappear during cleanup.
      }
    }
  } catch {
    // Upload cleanup must not block the current request.
  }
}

function normalizeSessionPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveChannelResourceSessionPath(engine: any, body: Record<string, any> = {}) {
  if (body?.resourceScope !== "channel") return null;
  if (!engine?.agentsDir) throw new UploadPathError("agentsDir required for channel resources");
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(channelId)) {
    throw new UploadPathError("invalid channelId");
  }
  const sessionsDir = path.join(engine.agentsDir, "_channels", "sessions");
  const sessionPath = path.join(sessionsDir, `${channelId}.jsonl`);
  await fs.mkdir(sessionsDir, { recursive: true });
  try {
    await fs.access(sessionPath);
  } catch {
    await fs.writeFile(sessionPath, "{}\n", "utf-8");
  }
  return sessionPath;
}

function validateUploadSessionPath(engine, sessionPath) {
  if (!sessionPath) return null;
  if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
    return "Invalid session path";
  }
  return null;
}

function resolveUploadTarget(engine, sessionPath) {
  if (sessionPath) {
    return {
      dir: sessionFilesCacheDir(engine.codiaHome, sessionPath),
      storageKind: "managed_cache",
      shouldCleanOldUploads: false,
    };
  }
  return {
    dir: path.join(engine.codiaHome, "uploads"),
    storageKind: undefined,
    shouldCleanOldUploads: true,
  };
}

function uniqueUploadName(base, ext) {
  return `${base}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}${ext}`;
}

function getKnowledgeGraphRuntime(engine) {
  const pluginEntry = engine?.pluginManager?.getPlugin?.("knowledge-graph");
  return pluginEntry?.ctx?._knowledgeGraph || null;
}

function canAutoSyncKnowledgeGraph(filePath) {
  return KG_SYNC_TEXT_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

async function syncUploadToKnowledgeGraph(engine, upload) {
  if (!upload || upload.error || upload.isDirectory || !upload.dest) return false;
  if (!canAutoSyncKnowledgeGraph(upload.dest)) return false;

  const runtime = getKnowledgeGraphRuntime(engine);
  const taskManager = runtime?.taskManager;
  if (!taskManager || typeof taskManager.submitBuildTask !== "function") return false;

  const taskState = typeof taskManager.getTaskState === "function" ? taskManager.getTaskState() : null;
  if (taskState?.is_building) return false;

  let text = "";
  try {
    text = await fs.readFile(upload.dest, "utf8");
  } catch {
    return false;
  }

  const normalizedText = String(text || "").trim();
  if (!normalizedText) return false;

  const submission = taskManager.submitBuildTask({
    documents: [
      {
        id: `upload:${path.basename(upload.dest)}`,
        title: String(upload.name || path.basename(upload.dest)),
        text: normalizedText.slice(0, MAX_KG_SYNC_TEXT_CHARS),
      },
    ],
    rebuild: false,
    parentSessionPath: "",
  });

  return Boolean(submission?.accepted);
}

export function createUploadRoute(engine) {
  const route = new Hono();

  route.post("/upload", async (c) => {
    const body = await safeJson(c);
    const { paths } = body;
    let sessionPath;
    try {
      sessionPath = await resolveChannelResourceSessionPath(engine, body) || normalizeSessionPath(body?.sessionPath);
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
    const sessionPathError = validateUploadSessionPath(engine, sessionPath);
    if (sessionPathError) return c.json({ error: sessionPathError }, 403);
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: t("error.pathsRequired") }, 400);
    }

    const uploadTarget = resolveUploadTarget(engine, sessionPath);
    const uploadsDir = uploadTarget.dir;
    await fs.mkdir(uploadsDir, { recursive: true });
    if (uploadTarget.shouldCleanOldUploads) cleanOldUploads(uploadsDir).catch(() => {});

    const results = [];
    let totalFiles = 0;

    for (const srcPath of paths) {
      if (totalFiles > MAX_FILES) {
        results.push({
          src: srcPath,
          error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
        });
        continue;
      }

      try {
        if (!path.isAbsolute(srcPath)) {
          results.push({ src: srcPath, error: "Path must be absolute" });
          continue;
        }

        let stat;
        try {
          stat = await fs.lstat(srcPath);
        } catch {
          results.push({ src: srcPath, error: t("error.pathNotFound") });
          continue;
        }

        if (stat.isSymbolicLink()) {
          results.push({ src: srcPath, error: "symlink not allowed" });
          continue;
        }
        if (isSensitivePath(srcPath, engine.codiaHome)) {
          results.push({ src: srcPath, error: "sensitive path blocked" });
          continue;
        }

        const pathFileCount = await countFiles(srcPath, { limit: MAX_FILES - totalFiles });
        totalFiles += pathFileCount;
        if (totalFiles > MAX_FILES) {
          results.push({
            src: srcPath,
            error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
          });
          continue;
        }

        const name = path.basename(srcPath);
        const isDir = stat.isDirectory();
        const ext = isDir ? "" : path.extname(srcPath);
        const base = isDir ? name : path.basename(srcPath, ext);
        const destName = uniqueUploadName(base, ext);
        const destPath = path.join(uploadsDir, destName);

        if (isDir) {
          await fs.cp(srcPath, destPath, { recursive: true });
        } else {
          await fs.copyFile(srcPath, destPath);
        }

        const sessionFile = registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: destPath,
          label: name,
          origin: "user_upload",
          storageKind: uploadTarget.storageKind,
          waveform: waveformForUploadPath(body, srcPath),
        });

        results.push({
          src: srcPath,
          dest: destPath,
          name,
          isDirectory: isDir,
          ...(sessionFile || {}),
        });

        await syncUploadToKnowledgeGraph(engine, results[results.length - 1]).catch(() => {});
      } catch (err) {
        results.push({ src: srcPath, error: err?.message || String(err) });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  route.post("/upload-blob", async (c) => {
    const body = await safeJson(c);
    let sessionPath;
    try {
      sessionPath = await resolveChannelResourceSessionPath(engine, body) || normalizeSessionPath(body?.sessionPath);
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
    const sessionPathError = validateUploadSessionPath(engine, sessionPath);
    if (sessionPathError) return c.json({ error: sessionPathError }, 403);
    let blobs = body?.blobs;
    if (!Array.isArray(blobs)) {
      if (body?.base64Data) {
        blobs = [{
          name: body.name,
          base64Data: body.base64Data,
          mimeType: body.mimeType,
          presentation: body.presentation,
        }];
      } else {
        return c.json({ error: t("error.pathsRequired") }, 400);
      }
    }
    if (blobs.length === 0) return c.json({ error: t("error.pathsRequired") }, 400);

    const uploadTarget = resolveUploadTarget(engine, sessionPath);
    const uploadsDir = uploadTarget.dir;
    await fs.mkdir(uploadsDir, { recursive: true });
    if (uploadTarget.shouldCleanOldUploads) cleanOldUploads(uploadsDir).catch(() => {});

    const results = [];
    for (let i = 0; i < blobs.length; i += 1) {
      if (i >= MAX_FILES) {
        results.push({ error: t("error.tooManyFiles", { max: MAX_FILES, n: blobs.length }) });
        continue;
      }

      const { name, base64Data, mimeType } = blobs[i] || {};
      try {
        if (typeof base64Data !== "string" || !base64Data) {
          results.push({ error: "base64Data required" });
          continue;
        }
        if (typeof mimeType !== "string" || !isAllowedUploadBlobMime(mimeType)) {
          results.push({ error: "unsupported mimeType" });
          continue;
        }
        if (!isUploadBlobBase64WithinLimit(base64Data, mimeType)) {
          results.push({ error: `blob too large (max ${uploadBlobMaxBase64Chars(mimeType)} bytes)` });
          continue;
        }
        const presentation = normalizeSessionFilePresentation(blobs[i]?.presentation ?? body?.presentation);
        if (!presentation) {
          results.push({ error: "unsupported presentation" });
          continue;
        }
        if (presentation === "voice-input" && !isAllowedUploadAudioMime(mimeType)) {
          results.push({ error: "voice-input requires audio mimeType" });
          continue;
        }

        const buf = Buffer.from(base64Data, "base64");
        if (buf.length === 0) {
          results.push({ error: "empty blob" });
          continue;
        }

        const safeName = sanitizeBlobName(name, mimeType);
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        const destName = uniqueUploadName(base, ext);
        const destPath = path.join(uploadsDir, destName);

        await fs.writeFile(destPath, buf);

        const sessionFile = registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: destPath,
          label: safeName,
          origin: originForPresentation(presentation),
          storageKind: uploadTarget.storageKind,
          presentation,
          listed: listedForPresentation(presentation),
          waveform: blobs[i]?.waveform ?? body?.waveform,
        });

        results.push({
          dest: destPath,
          name: safeName,
          isDirectory: false,
          ...(sessionFile || {}),
        });
      } catch (err) {
        results.push({ error: err?.message || String(err) });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  return route;
}
