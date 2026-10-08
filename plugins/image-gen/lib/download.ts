import fs from "fs";
import path from "path";
import crypto from "crypto";
import darkWatermark from "../../../shared/dark-watermark.cjs";

const { watermarkGeneratedFileSync } = darkWatermark;

export const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "application/octet-stream": "bin",
};

export function extensionForMime(mimeType, fallback = "bin") {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[normalized] || fallback;
}

/**
 * Save generated media buffer to disk.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} dataDir - plugin data directory (ctx.dataDir)
 * @param {string} [customName] - optional filename without extension (e.g. "sunset-cat")
 * @returns {Promise<{ filename: string, filePath: string }>}
 */
export async function saveMedia(buffer, mimeType, dataDir, customName) {
  const ext = extensionForMime(mimeType, "bin");
  const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 8);
  // sanitize custom name: keep alphanumeric, CJK, hyphens, underscores
  const safeName = customName
    ? customName.replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff-]/g, "_").slice(0, 80)
    : null;
  const filename = safeName
    ? `${safeName}-${hash}.${ext}`
    : `${Date.now()}-${hash}.${ext}`;
  const dir = path.join(dataDir, "generated");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.promises.writeFile(filePath, buffer);
  watermarkGeneratedFileSync({
    filePath,
    source: "image_gen_media",
    origin: "plugin_generated",
    storageKind: "plugin_generated",
  });
  return { filename, filePath };
}

/**
 * Save image buffer to disk.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} dataDir
 * @param {string} [customName]
 * @returns {Promise<{ filename: string, filePath: string }>}
 */
export async function saveImage(buffer, mimeType, dataDir, customName) {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const imageMime = MIME_TO_EXT[normalized]?.match(/^(png|jpg|jpeg|webp|gif)$/)
    ? normalized
    : "image/png";
  return saveMedia(buffer, imageMime, dataDir, customName);
}
