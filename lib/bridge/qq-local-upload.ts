// @ts-nocheck
import crypto from "crypto";
import fs from "fs";
import path from "path";

export const QQ_FILE_TYPE = Object.freeze({
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
});

export const QQ_UPLOAD_SIZE_LIMITS = Object.freeze({
  [QQ_FILE_TYPE.IMAGE]: 30 * 1024 * 1024,
  [QQ_FILE_TYPE.VIDEO]: 100 * 1024 * 1024,
  [QQ_FILE_TYPE.VOICE]: 20 * 1024 * 1024,
  [QQ_FILE_TYPE.FILE]: 100 * 1024 * 1024,
});

const MD5_10M_SIZE = 10_002_432;
const DEFAULT_CONCURRENT_PARTS = 1;
const MAX_CONCURRENT_PARTS = 10;
const PART_UPLOAD_TIMEOUT_MS = 300_000;
const PART_UPLOAD_MAX_RETRIES = 2;
const PART_FINISH_MAX_RETRIES = 2;
const PART_FINISH_BASE_DELAY_MS = 1000;
const PART_FINISH_RETRYABLE_CODE = 40093001;
const PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const PART_FINISH_RETRYABLE_INTERVAL_MS = 1000;
const MAX_PART_FINISH_RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETE_UPLOAD_MAX_RETRIES = 2;
const COMPLETE_UPLOAD_BASE_DELAY_MS = 2000;

export class QQApiError extends Error {
  constructor(message, { status, path: requestPath, bizCode } = {}) {
    super(message);
    this.name = "QQApiError";
    this.status = status;
    this.path = requestPath;
    this.bizCode = bizCode;
  }
}

export async function uploadQQLocalFile({ apiRequest, outboundHttp, chatId, filePath, fileType, metadata = {} }) {
  if (typeof outboundHttp?.request !== "function") {
    throw new Error("uploadQQLocalFile requires outboundHttp");
  }
  const targets = qqMediaTargets(chatId, metadata);
  let lastError = null;
  for (const target of targets) {
    if (target.scope === "group" && fileType === QQ_FILE_TYPE.FILE) {
      lastError = new Error("QQ group chats do not currently support document media delivery");
      continue;
    }
    try {
      return await chunkedUploadLocalFile({ apiRequest, outboundHttp, target, filePath, fileType, metadata });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (metadata.isGroup !== undefined) throw lastError;
    }
  }
  throw lastError || new Error("QQ local file upload failed");
}

function qqMediaTargets(chatId, metadata = {}) {
  const scopes = metadata.isGroup === true ? ["group"]
    : metadata.isGroup === false ? ["user"]
      : ["user", "group"];
  return scopes.map((scope) => {
    const base = scope === "group" ? `/v2/groups/${chatId}` : `/v2/users/${chatId}`;
    return {
      scope,
      prepare: `${base}/upload_prepare`,
      partFinish: `${base}/upload_part_finish`,
      complete: `${base}/files`,
    };
  });
}

async function chunkedUploadLocalFile({ apiRequest, outboundHttp, target, filePath, fileType, metadata }) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`QQ can only upload files, not directories: ${filePath}`);
  if (stat.size === 0) throw new Error(`QQ cannot send an empty file: ${filePath}`);
  const maxBytes = QQ_UPLOAD_SIZE_LIMITS[fileType] || QQ_UPLOAD_SIZE_LIMITS[QQ_FILE_TYPE.FILE];
  if (stat.size > maxBytes) {
    throw new Error(`QQ file exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit: ${path.basename(filePath)}`);
  }

  const filename = sanitizeUploadFileName(metadata.filename || path.basename(filePath));
  const hashes = await computeLocalFileHashes(filePath, stat.size);
  const prepare = await apiRequest("POST", target.prepare, {
    file_type: fileType,
    file_name: filename,
    file_size: stat.size,
    md5: hashes.md5,
    sha1: hashes.sha1,
    md5_10m: hashes.md5_10m,
    srv_send_msg: false,
  }, { stage: "upload_prepare" });

  if (prepare.file_info) return prepare;
  if (prepare.upload_id && Array.isArray(prepare.parts)) {
    return uploadPreparedParts({ apiRequest, outboundHttp, target, filePath, stat, prepare });
  }

  const fileUuid = prepare.file_uuid || prepare.file_id || prepare.fileId;
  const partSize = Number(prepare.part_size || prepare.chunk_size || prepare.block_size || 1024 * 1024);
  const uploadUrls = normalizeUploadUrls(prepare);
  const partCount = Math.ceil(stat.size / partSize);
  if (!fileUuid) throw new Error("QQ upload_prepare did not return file_uuid");
  if (!uploadUrls.length) throw new Error("QQ upload_prepare did not return upload URLs");

  await uploadParts({ outboundHttp, filePath, fileUuid, partSize, partCount, uploadUrls, concurrency: prepare.concurrent_parts });
  await finishPartsWithRetry({ apiRequest, target, fileUuid, partCount, prepare });

  return retryAsync(() => apiRequest("POST", target.complete, {
    file_type: fileType,
    file_uuid: fileUuid,
    srv_send_msg: false,
  }, { stage: "upload_complete" }), COMPLETE_UPLOAD_MAX_RETRIES, COMPLETE_UPLOAD_BASE_DELAY_MS);
}

function sanitizeUploadFileName(value) {
  const base = path.basename(String(value || "file"));
  const cleaned = Array.from(base, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1F || code === 0x7F ? "_" : char;
  }).join("").trim();
  return cleaned.slice(0, 128) || "file";
}

async function computeLocalFileHashes(filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash("md5");
    const sha1 = crypto.createHash("sha1");
    const md5First10m = crypto.createHash("md5");
    const needsFirst10m = fileSize > MD5_10M_SIZE;
    let bytesRead = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      md5.update(buffer);
      sha1.update(buffer);
      if (needsFirst10m) {
        const remaining = MD5_10M_SIZE - bytesRead;
        if (remaining > 0) {
          md5First10m.update(remaining >= buffer.length ? buffer : buffer.subarray(0, remaining));
        }
      }
      bytesRead += buffer.length;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const md5Hex = md5.digest("hex");
      resolve({
        md5: md5Hex,
        sha1: sha1.digest("hex"),
        md5_10m: needsFirst10m ? md5First10m.digest("hex") : md5Hex,
      });
    });
  });
}

async function uploadPreparedParts({ apiRequest, outboundHttp, target, filePath, stat, prepare }) {
  const uploadId = prepare.upload_id;
  const blockSize = Number(prepare.block_size);
  const parts = Array.isArray(prepare.parts) ? prepare.parts : [];
  if (!uploadId || !Number.isFinite(blockSize) || blockSize <= 0 || !parts.length) {
    throw new Error("QQ upload_prepare returned invalid part metadata");
  }
  const concurrency = Math.min(
    Math.max(Number(prepare.concurrency) || DEFAULT_CONCURRENT_PARTS, 1),
    MAX_CONCURRENT_PARTS,
  );
  const retryTimeoutMs = parseRetryTimeoutMs(prepare.retry_timeout);
  await runWithConcurrency(parts.map((part) => async () => {
    const partIndex = Number(part.index);
    if (!Number.isInteger(partIndex) || partIndex <= 0 || !part.presigned_url) {
      throw new Error("QQ upload_prepare returned an invalid part");
    }
    const offset = (partIndex - 1) * blockSize;
    const length = Math.min(blockSize, stat.size - offset);
    if (length <= 0) throw new Error("QQ upload_prepare part range exceeds file size");
    const chunk = await readFileChunk(filePath, offset, length);
    const md5 = crypto.createHash("md5").update(chunk).digest("hex");
    await putToPresignedUrl(outboundHttp, part.presigned_url, chunk);
    await finishUploadPart(apiRequest, target.partFinish, {
      upload_id: uploadId,
      part_index: partIndex,
      block_size: length,
      md5,
    }, retryTimeoutMs);
  }), concurrency);
  return completeUploadWithRetry(apiRequest, target.complete, { upload_id: uploadId });
}

function parseRetryTimeoutMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, MAX_PART_FINISH_RETRY_TIMEOUT_MS);
}

async function readFileChunk(filePath, offset, length) {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

async function putToPresignedUrl(outboundHttp, url, buffer) {
  const body = new Blob([buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)]);
  const res = await outboundHttp.request({
    stage: "upload_part_put",
    url,
    method: "PUT",
    headers: { "Content-Length": String(buffer.length) },
    body,
    timeoutMs: PART_UPLOAD_TIMEOUT_MS,
    idempotent: true,
    maxRetries: PART_UPLOAD_MAX_RETRIES,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`QQ part upload failed: ${res.status} ${res.statusText || ""} ${text.slice(0, 200)}`.trim());
  }
}

function normalizeUploadUrls(prepare) {
  const candidates = prepare.upload_urls || prepare.uploadUrls || prepare.urls || prepare.upload_url || prepare.uploadUrl;
  if (!candidates) return [];
  if (Array.isArray(candidates)) return candidates.map(normalizeUploadUrl).filter(Boolean);
  return [normalizeUploadUrl(candidates)].filter(Boolean);
}

function normalizeUploadUrl(value) {
  if (!value) return null;
  if (typeof value === "string") return { url: value };
  if (typeof value === "object" && value.url) return value;
  return null;
}

async function uploadParts({ outboundHttp, filePath, fileUuid, partSize, partCount, uploadUrls, concurrency }) {
  const maxConcurrency = Math.max(1, Math.min(MAX_CONCURRENT_PARTS, Number(concurrency) || DEFAULT_CONCURRENT_PARTS));
  let nextPart = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, partCount) }, async () => {
    while (nextPart < partCount) {
      const partIndex = nextPart++;
      const start = partIndex * partSize;
      const end = Math.min(start + partSize, fs.statSync(filePath).size);
      const buffer = Buffer.allocUnsafe(end - start);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }
      const upload = uploadUrls[Math.min(partIndex, uploadUrls.length - 1)];
      await retryAsync(() => uploadPart(outboundHttp, upload, buffer, { fileUuid, partIndex, start, end }), PART_UPLOAD_MAX_RETRIES, 500);
    }
  });
  await Promise.all(workers);
}

async function uploadPart(outboundHttp, upload, buffer, { fileUuid, partIndex, start, end }) {
  const headers = { ...(upload.headers || {}) };
  if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/octet-stream";
  const url = withPartQuery(upload.url, { fileUuid, partIndex, start, end });
  const res = await outboundHttp.request({
    stage: "upload_part_put",
    url,
    method: upload.method || "PUT",
    headers,
    body: buffer,
    timeoutMs: PART_UPLOAD_TIMEOUT_MS,
    idempotent: true,
    maxRetries: 0,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`QQ part upload ${partIndex + 1} failed: ${res.status} ${text.slice(0, 120)}`);
  }
}

function withPartQuery(url, params) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("file_uuid")) u.searchParams.set("file_uuid", params.fileUuid);
    if (!u.searchParams.has("part_number")) u.searchParams.set("part_number", String(params.partIndex + 1));
    return u.toString();
  } catch {
    return url;
  }
}

async function finishPartsWithRetry({ apiRequest, target, fileUuid, partCount, prepare }) {
  const started = Date.now();
  let retryTimeoutMs = Number(prepare.part_finish_retry_timeout_ms) || PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS;
  retryTimeoutMs = Math.min(retryTimeoutMs, MAX_PART_FINISH_RETRY_TIMEOUT_MS);

  while (true) {
    try {
      return await retryAsync(() => apiRequest("POST", target.partFinish, {
        file_uuid: fileUuid,
        part_count: partCount,
      }, { stage: "upload_part_finish" }), PART_FINISH_MAX_RETRIES, PART_FINISH_BASE_DELAY_MS);
    } catch (err) {
      if (!isPartFinishRetryable(err) || Date.now() - started > retryTimeoutMs) throw err;
      await delay(PART_FINISH_RETRYABLE_INTERVAL_MS);
    }
  }
}

async function finishUploadPart(apiRequest, endpoint, body, retryTimeoutMs) {
  let lastError = null;
  for (let attempt = 0; attempt <= PART_FINISH_MAX_RETRIES; attempt += 1) {
    try {
      await apiRequest("POST", endpoint, body, { stage: "upload_part_finish" });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof QQApiError && err.bizCode === PART_FINISH_RETRYABLE_CODE) {
        await retryUploadPartFinishUntilReady(apiRequest, endpoint, body, retryTimeoutMs);
        return;
      }
      if (attempt < PART_FINISH_MAX_RETRIES) {
        await delay(PART_FINISH_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

async function retryUploadPartFinishUntilReady(apiRequest, endpoint, body, retryTimeoutMs) {
  const deadline = Date.now() + (retryTimeoutMs || PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await apiRequest("POST", endpoint, body, { stage: "upload_part_finish" });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!(err instanceof QQApiError) || err.bizCode !== PART_FINISH_RETRYABLE_CODE) throw lastError;
      await delay(Math.min(PART_FINISH_RETRYABLE_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
  }
  throw lastError || new Error("QQ upload_part_finish retry timed out");
}

async function completeUploadWithRetry(apiRequest, endpoint, body) {
  return retryAsync(
    () => apiRequest("POST", endpoint, body, { stage: "upload_complete" }),
    COMPLETE_UPLOAD_MAX_RETRIES,
    COMPLETE_UPLOAD_BASE_DELAY_MS,
  );
}

async function runWithConcurrency(tasks, concurrency) {
  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.all(tasks.slice(i, i + concurrency).map((task) => task()));
  }
}

function isPartFinishRetryable(err) {
  return err?.bizCode === PART_FINISH_RETRYABLE_CODE || String(err?.message || "").includes(String(PART_FINISH_RETRYABLE_CODE));
}

async function retryAsync(fn, retries, baseDelayMs) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await delay(baseDelayMs * (attempt + 1));
      attempt += 1;
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
