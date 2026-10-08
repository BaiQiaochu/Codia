import { Buffer } from "node:buffer";
import * as piSdk from "../lib/pi-sdk/index.ts";

export const MODEL_IMAGE_INPUT_POLICY = Object.freeze({
  maxWidth: 2000,
  maxHeight: 2000,
  maxImageBase64Bytes: 4.5 * 1024 * 1024,
  totalBase64BudgetBytes: 24 * 1024 * 1024,
  jpegQuality: 80,
});

function imagePreprocessError(message) {
  const error: any = new Error(`image input preprocessing failed: ${message}`);
  error.code = "IMAGE_INPUT_PREPROCESS_FAILED";
  return error;
}

function byteLengthBase64(data) {
  return Buffer.byteLength(String(data || ""), "utf-8");
}

function normalizeMimeType(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  if (mime === "image/x-png") return "image/png";
  return mime;
}

function decodeBase64Strict(data) {
  const normalized = String(data || "").replace(/\s/g, "");
  if (!normalized || /[^A-Za-z0-9+/=]/.test(normalized) || normalized.length % 4 === 1) {
    return null;
  }
  try {
    const buffer = Buffer.from(normalized, "base64");
    if (!buffer.length) return null;
    const encoded = buffer.toString("base64").replace(/=+$/, "");
    const input = normalized.replace(/=+$/, "");
    if (encoded !== input) return null;
    return { buffer, data: normalized };
  } catch {
    return null;
  }
}

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function fallbackOriginalImageWithinBudget(image, perImageMaxBytes) {
  if (byteLengthBase64(image?.data) > perImageMaxBytes) return null;
  const decoded = decodeBase64Strict(image?.data);
  if (!decoded) return null;
  const detectedMimeType = detectImageMimeType(decoded.buffer);
  if (!detectedMimeType) return null;
  const declaredMimeType = normalizeMimeType(image?.mimeType);
  if (declaredMimeType && declaredMimeType !== detectedMimeType) return null;
  return {
    data: decoded.data,
    mimeType: declaredMimeType || detectedMimeType,
  };
}

function normalizePolicy(policy = {}) {
  const merged = { ...MODEL_IMAGE_INPUT_POLICY, ...(policy || {}) };
  for (const key of ["maxWidth", "maxHeight", "maxImageBase64Bytes", "totalBase64BudgetBytes", "jpegQuality"]) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
      throw imagePreprocessError(`invalid policy.${key}`);
    }
  }
  return merged;
}

function assertImageInput(image, index) {
  if (!image || typeof image !== "object") {
    throw imagePreprocessError(`image ${index + 1} is not an object`);
  }
  if (image.type && image.type !== "image") {
    throw imagePreprocessError(`image ${index + 1} has unsupported type "${image.type}"`);
  }
  if (typeof image.data !== "string" || image.data.length === 0) {
    throw imagePreprocessError(`image ${index + 1} has empty base64 data`);
  }
  if (image.mimeType && !String(image.mimeType).startsWith("image/")) {
    throw imagePreprocessError(`image ${index + 1} has unsupported mimeType "${image.mimeType}"`);
  }
}

function escapeXmlAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildDimensionNoteLine(note, path, index) {
  const name = path || `image-${index + 1}`;
  return `<file name="${escapeXmlAttr(name)}">${escapeXmlText(note)}</file>`;
}

function appendDimensionNotes(text, notes) {
  if (!notes.length) return text;
  const noteText = notes.map(({ note, path, index }) => buildDimensionNoteLine(note, path, index)).join("\n");
  const sourceText = typeof text === "string" ? text : String(text ?? "");
  if (!sourceText) return noteText;

  const lines = sourceText.split("\n");
  let markerEnd = 0;
  while (markerEnd < lines.length && /^\[attached_image: .+\]$/.test(lines[markerEnd])) {
    markerEnd += 1;
  }

  if (markerEnd === 0) return `${noteText}\n${sourceText}`;
  const before = lines.slice(0, markerEnd).join("\n");
  const after = lines.slice(markerEnd).join("\n");
  return after ? `${before}\n${noteText}\n${after}` : `${before}\n${noteText}`;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error: any = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

type PrepareModelImageInputsOptions = Record<string, any>;

export async function prepareModelImageInputsForPrompt({
  text,
  opts,
  imagePolicy,
  resizeImage,
  formatDimensionNote,
  signal,
}: PrepareModelImageInputsOptions = {}) {
  if (!Array.isArray(opts?.images) || opts.images.length === 0) {
    return { text, opts };
  }
  if (opts.modelImageInputsPrepared) {
    return { text, opts };
  }
  const effectiveResizeImage = resizeImage ?? piSdk.resizeModelImageInput;
  const effectiveFormatDimensionNote = formatDimensionNote ?? piSdk.formatModelImageDimensionNote;
  if (typeof effectiveResizeImage !== "function") {
    throw imagePreprocessError("image resize adapter unavailable");
  }
  if (typeof effectiveFormatDimensionNote !== "function") {
    throw imagePreprocessError("image dimension-note adapter unavailable");
  }

  const policy = normalizePolicy(imagePolicy);
  const perImageMaxBytes = Math.max(
    1,
    Math.floor(Math.min(policy.maxImageBase64Bytes, policy.totalBase64BudgetBytes / opts.images.length))
  );
  const resizeOptions = {
    maxWidth: policy.maxWidth,
    maxHeight: policy.maxHeight,
    maxBytes: perImageMaxBytes,
    jpegQuality: policy.jpegQuality,
  };

  const nextImages = [];
  const dimensionNotes = [];

  for (let index = 0; index < opts.images.length; index += 1) {
    throwIfAborted(signal);
    const image = opts.images[index];
    assertImageInput(image, index);
    const resized = await effectiveResizeImage(image, resizeOptions);
    throwIfAborted(signal);

    if (!resized?.data) {
      const fallback = fallbackOriginalImageWithinBudget(image, perImageMaxBytes);
      if (!fallback) {
        throw imagePreprocessError(`image ${index + 1} could not be compressed below ${perImageMaxBytes} base64 bytes`);
      }
      nextImages.push({
        ...image,
        type: "image",
        data: fallback.data,
        mimeType: fallback.mimeType,
      });
      continue;
    }

    nextImages.push({
      ...image,
      type: "image",
      data: resized.data,
      mimeType: resized.mimeType || image.mimeType,
    });

    const note = await effectiveFormatDimensionNote(resized);
    if (note) {
      dimensionNotes.push({
        note,
        index,
        path: Array.isArray(opts.imageAttachmentPaths) ? opts.imageAttachmentPaths[index] : undefined,
      });
    }
  }

  const totalBytes = nextImages.reduce((sum, image) => sum + byteLengthBase64(image.data), 0);
  if (totalBytes > policy.totalBase64BudgetBytes) {
    throw imagePreprocessError(`compressed images exceed the ${policy.totalBase64BudgetBytes} base64-byte request budget`);
  }

  return {
    text: appendDimensionNotes(text, dimensionNotes),
    opts: {
      ...opts,
      images: nextImages,
      modelImageInputsPrepared: true,
    },
  };
}
