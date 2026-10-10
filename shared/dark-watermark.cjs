const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRODUCT = "Codia";
const WATERMARK_VERSION = 1;
const INVISIBLE_PREFIX = "\u2063\u2063";
const INVISIBLE_SUFFIX = "\u2064\u2064";
const BIT_ZERO = "\u200c";
const BIT_ONE = "\u200d";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT_KEYWORD = "Codia-Provenance";
const TEXT_WATERMARK_EXTS = new Set(["txt", "md", "markdown", "html", "htm", "csv", "log"]);

function buildWatermarkPayload(input = {}, opts = {}) {
  const now = opts.now ? opts.now() : new Date().toISOString();
  const createdAt = typeof now === "number" ? new Date(now).toISOString() : String(now);
  const payload = {
    version: WATERMARK_VERSION,
    product: PRODUCT,
    source: input.source || input.origin || "platform_output",
    traceId: opts.randomId ? opts.randomId() : crypto.randomUUID(),
    createdAt,
    ...(input.sessionPath ? { sessionPath: String(input.sessionPath) } : {}),
    ...(input.filePath ? { filePath: String(input.filePath) } : {}),
    ...(input.origin ? { origin: String(input.origin) } : {}),
    ...(input.storageKind ? { storageKind: String(input.storageKind) } : {}),
    ...(input.agentId ? { agentId: String(input.agentId) } : {}),
    ...(input.artifactId ? { artifactId: String(input.artifactId) } : {}),
  };
  return {
    ...payload,
    signature: signPayload(payload, opts.secret || ""),
  };
}

function signPayload(payload, secret = "") {
  const canonical = canonicalStringify(payload);
  if (secret) {
    return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  }
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

function encodeInvisiblePayload(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  let bits = "";
  for (const byte of bytes) {
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      bits += (byte & mask) ? BIT_ONE : BIT_ZERO;
    }
  }
  return `${INVISIBLE_PREFIX}${bits}${INVISIBLE_SUFFIX}`;
}

function decodeInvisiblePayload(bits) {
  if (!bits || bits.length % 8 !== 0) return null;
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      const ch = bits[i + j];
      if (ch !== BIT_ZERO && ch !== BIT_ONE) return null;
      byte = (byte << 1) | (ch === BIT_ONE ? 1 : 0);
    }
    bytes.push(byte);
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
}

function appendInvisibleWatermark(text, payload) {
  const source = String(text || "");
  if (extractInvisibleWatermarks(source).length > 0) return source;
  return `${source}${encodeInvisiblePayload(payload)}`;
}

function extractInvisibleWatermarks(text) {
  const source = String(text || "");
  const pattern = new RegExp(`${INVISIBLE_PREFIX}([${BIT_ZERO}${BIT_ONE}]+)${INVISIBLE_SUFFIX}`, "g");
  const results = [];
  for (const match of source.matchAll(pattern)) {
    const decoded = decodeInvisiblePayload(match[1]);
    if (decoded) results.push(decoded);
  }
  return results;
}

function watermarkFileSync({ filePath, payload } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { applied: false, method: "missing" };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { applied: false, method: "unsupported" };
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (TEXT_WATERMARK_EXTS.has(ext)) {
    const current = fs.readFileSync(filePath, "utf8");
    const next = appendInvisibleWatermark(current, payload);
    if (next !== current) fs.writeFileSync(filePath, next, "utf8");
    return { applied: true, method: "text-invisible" };
  }

  if (ext === "png") {
    const current = fs.readFileSync(filePath);
    const next = writePngWatermark(current, payload);
    if (next) {
      if (next !== current) fs.writeFileSync(filePath, next);
      return { applied: true, method: "png-text-chunk" };
    }
  }

  const sidecarPath = writeWatermarkSidecarSync(filePath, payload);
  return { applied: true, method: "file-sidecar", sidecarPath };
}

function watermarkGeneratedFileSync({ filePath, source = "platform_output", origin, storageKind = "generated", ...extra } = {}, opts = {}) {
  const payload = buildWatermarkPayload({
    source,
    filePath,
    origin: origin || source,
    storageKind,
    ...extra,
  }, opts);

  try {
    const result = watermarkFileSync({ filePath, payload });
    return {
      ...payload,
      applied: result.applied === true,
      method: result.method || "unknown",
      ...(result.sidecarPath ? { sidecarPath: result.sidecarPath } : {}),
    };
  } catch (err) {
    return {
      ...payload,
      applied: false,
      method: "failed",
      error: err?.message || String(err),
    };
  }
}

function writeWatermarkSidecarSync(filePath, payload) {
  const stat = fs.statSync(filePath);
  const sidecarPath = `${filePath}.codia-watermark.json`;
  const body = {
    version: WATERMARK_VERSION,
    product: PRODUCT,
    filePath,
    size: stat.size,
    sha256: sha256File(filePath),
    payload,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return sidecarPath;
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 20 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function writePngWatermark(buffer, payload) {
  if (!isPng(buffer)) return null;
  if (hasPngWatermark(buffer)) return buffer;
  const iend = findPngChunk(buffer, "IEND");
  if (!iend) return null;

  const chunk = buildPngChunk("tEXt", Buffer.from(`${PNG_TEXT_KEYWORD}\0${JSON.stringify(payload)}`, "utf8"));
  return Buffer.concat([
    buffer.subarray(0, iend.offset),
    chunk,
    buffer.subarray(iend.offset),
  ]);
}

function hasPngWatermark(buffer) {
  if (!isPng(buffer)) return false;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (dataEnd > buffer.length || next > buffer.length) return false;
    if (type === "tEXt") {
      const nul = buffer.indexOf(0, dataStart);
      if (nul >= dataStart && nul < dataEnd) {
        const keyword = buffer.subarray(dataStart, nul).toString("latin1");
        if (keyword === PNG_TEXT_KEYWORD) return true;
      }
    }
    if (type === "IEND") return false;
    offset = next;
  }
  return false;
}

function findPngChunk(buffer, targetType) {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataEnd = offset + 8 + length;
    const next = dataEnd + 4;
    if (dataEnd > buffer.length || next > buffer.length) return null;
    if (type === targetType) return { offset, length, type, next };
    offset = next;
  }
  return null;
}

function buildPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

module.exports = {
  PRODUCT,
  WATERMARK_VERSION,
  appendInvisibleWatermark,
  buildWatermarkPayload,
  extractInvisibleWatermarks,
  hasPngWatermark,
  watermarkFileSync,
  watermarkGeneratedFileSync,
  writePngWatermark,
  writeWatermarkSidecarSync,
};
