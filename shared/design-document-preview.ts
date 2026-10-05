import fs from "fs";
import path from "path";
import zlib from "zlib";

const MAX_DESIGN_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_STRING_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SECTION_ITEMS = 80;

export const DESIGN_DOCUMENT_EXTENSIONS = Object.freeze([
  "dwg",
  "dxf",
  "dwt",
  "max",
  "3ds",
  "fbx",
  "obj",
  "stl",
  "xmind",
]);

const EXTENSION_INFO = Object.freeze({
  dwg: { kind: "cad", format: "AutoCAD DWG", native: false },
  dwt: { kind: "cad", format: "AutoCAD Template", native: false },
  dxf: { kind: "cad", format: "DXF", native: true },
  max: { kind: "three-d", format: "3ds Max", native: false },
  "3ds": { kind: "three-d", format: "3D Studio", native: false },
  fbx: { kind: "three-d", format: "FBX", native: true },
  obj: { kind: "three-d", format: "Wavefront OBJ", native: true },
  stl: { kind: "three-d", format: "STL", native: true },
  xmind: { kind: "mindmap", format: "XMind", native: true },
});

export function isDesignDocumentExtension(ext) {
  return DESIGN_DOCUMENT_EXTENSIONS.includes(normalizeExt(ext));
}

export async function parseDesignDocumentPreview(filePath, options: any = {}) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw createPreviewError("Design preview target is not a file", "DESIGN_PREVIEW_NOT_FILE", 400);
  }
  const maxBytes = options.maxBytes ?? MAX_DESIGN_PREVIEW_BYTES;
  if (stat.size > maxBytes) {
    throw createPreviewError("Design preview file is too large", "DESIGN_PREVIEW_FILE_TOO_LARGE", 413);
  }

  const ext = normalizeExt(path.extname(resolved));
  if (!isDesignDocumentExtension(ext)) {
    throw createPreviewError(`Unsupported design document extension: ${ext}`, "DESIGN_PREVIEW_UNSUPPORTED", 415);
  }

  if (ext === "xmind") {
    return parseXmindPreview(resolved, stat, ext);
  }

  if (ext === "dxf") return parseDxfPreview(resolved, stat, ext);
  if (ext === "obj") return parseObjPreview(resolved, stat, ext);
  if (ext === "fbx") return parseFbxPreview(resolved, stat, ext);
  if (ext === "stl") return parseStlPreview(resolved, stat, ext);
  return parseBinaryDesignPreview(resolved, stat, ext);
}

function createPreviewError(message, code, status = 400) {
  const err: any = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalizeExt(ext) {
  return String(ext || "").replace(/^\./, "").trim().toLowerCase();
}

function basePreview(filePath, stat, ext) {
  const info = EXTENSION_INFO[ext] || { kind: "design", format: ext.toUpperCase(), native: false };
  return {
    kind: info.kind,
    format: info.format,
    title: path.basename(filePath),
    fileName: path.basename(filePath),
    filePath,
    ext,
    fileSize: stat.size,
    canRenderNatively: info.native,
    summary: "",
    sections: [],
    warnings: [],
  };
}

function safePushUnique(list, item, limit = MAX_SECTION_ITEMS, options: any = {}) {
  const raw = String(item || "");
  const value = options.preserveWhitespace ? raw.replace(/\s+$/g, "") : raw.trim();
  if (!value.trim() || list.includes(value) || list.length >= limit) return;
  list.push(value);
}

function addSection(preview, title, items, options: any = {}) {
  const clean = (Array.isArray(items) ? items : [])
    .map((item) => {
      const raw = String(item || "");
      return options.preserveWhitespace ? raw.replace(/\s+$/g, "") : raw.trim();
    })
    .filter((item) => item.trim())
    .slice(0, MAX_SECTION_ITEMS);
  if (clean.length > 0) preview.sections.push({ title, items: clean });
}

function readTextSample(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, MAX_TEXT_SCAN_BYTES);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    const sample = buf.subarray(0, Math.min(buf.length, 8192));
    const nulCount = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
    const encoding = nulCount > sample.length / 8 ? "utf16le" : "utf8";
    return buf.toString(encoding).replaceAll(String.fromCharCode(0), "\n");
  } finally {
    fs.closeSync(fd);
  }
}

function countOccurrences(lines, tokens) {
  const counts = new Map<string, number>(tokens.map((token) => [token, 0]));
  for (const line of lines) {
    const token = line.trim().toUpperCase();
    if (counts.has(token)) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([token, count]) => `${token}: ${count}`);
}

function parseDxfPreview(filePath, stat, ext) {
  const preview = basePreview(filePath, stat, ext);
  const text = readTextSample(filePath);
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const entities = countOccurrences(lines, [
    "LINE",
    "LWPOLYLINE",
    "POLYLINE",
    "CIRCLE",
    "ARC",
    "TEXT",
    "MTEXT",
    "INSERT",
    "HATCH",
    "DIMENSION",
    "SPLINE",
  ]);
  const layers = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i] === "8") safePushUnique(layers, lines[i + 1]);
  }

  addSection(preview, "Layers", layers);
  addSection(preview, "Entities", entities);
  preview.summary = `DXF CAD drawing with ${sumCounts(entities)} recognized entities${layers.length ? ` across ${layers.length} layers` : ""}.`;
  return preview;
}

function parseObjPreview(filePath, stat, ext) {
  const preview = basePreview(filePath, stat, ext);
  const text = readTextSample(filePath);
  const lines = text.split(/\r?\n/);
  let vertices = 0;
  let faces = 0;
  let normals = 0;
  let texcoords = 0;
  const objects = [];
  const materials = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("v ")) vertices += 1;
    else if (line.startsWith("f ")) faces += 1;
    else if (line.startsWith("vn ")) normals += 1;
    else if (line.startsWith("vt ")) texcoords += 1;
    else if (line.startsWith("o ") || line.startsWith("g ")) safePushUnique(objects, line.slice(2));
    else if (line.startsWith("usemtl ")) safePushUnique(materials, line.slice(7));
  }

  addSection(preview, "Geometry", [
    `Vertices: ${vertices}`,
    `Faces: ${faces}`,
    `Normals: ${normals}`,
    `Texture coordinates: ${texcoords}`,
  ]);
  addSection(preview, "Objects", objects);
  addSection(preview, "Materials", materials);
  preview.summary = `Wavefront OBJ scene with ${vertices} vertices and ${faces} faces.`;
  return preview;
}

function parseFbxPreview(filePath, stat, ext) {
  const preview = basePreview(filePath, stat, ext);
  const sample = fs.readFileSync(filePath).subarray(0, MAX_TEXT_SCAN_BYTES);
  const isBinary = sample.subarray(0, 32).toString("ascii").includes("Kaydara FBX Binary");
  if (isBinary) {
    const strings = extractReadableStrings(sample);
    preview.canRenderNatively = false;
    preview.warnings.push("Binary FBX geometry rendering is not available in the built-in reader; showing metadata and readable identifiers.");
    addSection(preview, "Readable strings", strings);
    preview.summary = "Binary FBX scene summary.";
    return preview;
  }

  const text = sample.toString("utf8");
  const models = extractRegexValues(text, /Model:\s*"[^:"]+::([^"]+)"/g);
  const materials = extractRegexValues(text, /Material:\s*"[^:"]+::([^"]+)"/g);
  addSection(preview, "Models", models);
  addSection(preview, "Materials", materials);
  preview.summary = `ASCII FBX scene with ${models.length} model declarations.`;
  return preview;
}

function parseStlPreview(filePath, stat, ext) {
  const preview = basePreview(filePath, stat, ext);
  const text = readTextSample(filePath);
  const facets = (text.match(/\bfacet\s+normal\b/g) || []).length;
  const solids = extractRegexValues(text, /^solid\s+(.+)$/gm);
  addSection(preview, "Geometry", [`Facets: ${facets}`]);
  addSection(preview, "Solids", solids);
  preview.summary = `STL mesh with ${facets} ASCII facets.`;
  return preview;
}

function parseBinaryDesignPreview(filePath, stat, ext) {
  const preview = basePreview(filePath, stat, ext);
  const fd = fs.openSync(filePath, "r");
  try {
    const size = Math.min(stat.size, MAX_STRING_SCAN_BYTES);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    addSection(preview, "Header", [formatHexHeader(buf.subarray(0, 16))]);
    addSection(preview, "Readable strings", extractReadableStrings(buf));
  } finally {
    fs.closeSync(fd);
  }

  if (ext === "dwg" || ext === "dwt") {
    preview.warnings.push("Native DWG geometry rendering is not available in the built-in reader; showing metadata and readable identifiers.");
  } else if (ext === "max" || ext === "3ds") {
    preview.warnings.push("Native 3ds Max binary rendering is not available in the built-in reader; showing metadata and readable identifiers.");
  }
  preview.summary = `${preview.format} binary document summary.`;
  return preview;
}

function parseXmindPreview(filePath, stat, ext) {
  const preview = basePreview(filePath, stat, ext);
  const entries = readZipEntries(filePath);
  const content = entries.get("content.json")
    || entries.get("content.xml")
    || entries.get("content.json".toUpperCase());

  if (!content) {
    preview.warnings.push("No XMind content.json or content.xml entry was found.");
    preview.summary = "XMind archive metadata only.";
    addSection(preview, "Archive entries", [...entries.keys()].slice(0, MAX_SECTION_ITEMS));
    return preview;
  }

  const text = content.toString("utf8");
  const topics = text.trim().startsWith("<")
    ? extractXmlTitles(text)
    : extractXmindJsonTopics(text);

  addSection(preview, "Topics", topics, { preserveWhitespace: true });
  preview.summary = `XMind mind map with ${Math.max(0, topics.length - 1)} visible topics.`;
  return preview;
}

function extractXmindJsonTopics(text) {
  const topics = [];
  try {
    const root = JSON.parse(text);
    const sheets = Array.isArray(root) ? root : [root];
    for (const sheet of sheets) {
      safePushUnique(topics, sheet?.title);
      collectTopicTitles(sheet?.rootTopic, topics, 0);
    }
  } catch {
    for (const value of extractRegexValues(text, /"title"\s*:\s*"([^"]+)"/g)) {
      safePushUnique(topics, value);
    }
  }
  return topics;
}

function collectTopicTitles(topic, out, depth) {
  if (!topic || typeof topic !== "object" || out.length >= MAX_SECTION_ITEMS) return;
  safePushUnique(out, `${"  ".repeat(depth)}${topic.title || ""}`, MAX_SECTION_ITEMS, { preserveWhitespace: true });
  const children = topic.children;
  const groups = [];
  if (Array.isArray(children?.attached)) groups.push(children.attached);
  if (Array.isArray(children?.detached)) groups.push(children.detached);
  if (Array.isArray(children)) groups.push(children);
  for (const group of groups) {
    for (const child of group) collectTopicTitles(child, out, depth + 1);
  }
}

function extractXmlTitles(text) {
  const titles = [];
  for (const value of extractRegexValues(text, /<title[^>]*>([\s\S]*?)<\/title>/gi)) {
    safePushUnique(titles, decodeXml(value.replace(/<[^>]+>/g, "")));
  }
  return titles;
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function readZipEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = new Map();
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset < 0) return entries;

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let centralOffset = buf.readUInt32LE(eocdOffset + 16);
  for (let i = 0; i < entryCount && centralOffset < buf.length - 46; i += 1) {
    if (buf.readUInt32LE(centralOffset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(centralOffset + 10);
    const compressedSize = buf.readUInt32LE(centralOffset + 20);
    const uncompressedSize = buf.readUInt32LE(centralOffset + 24);
    const nameLen = buf.readUInt16LE(centralOffset + 28);
    const extraLen = buf.readUInt16LE(centralOffset + 30);
    const commentLen = buf.readUInt16LE(centralOffset + 32);
    const localOffset = buf.readUInt32LE(centralOffset + 42);
    const name = buf.subarray(centralOffset + 46, centralOffset + 46 + nameLen).toString("utf8");
    centralOffset += 46 + nameLen + extraLen + commentLen;

    if (!isSafeXmindEntry(name) || compressedSize > MAX_TEXT_SCAN_BYTES || uncompressedSize > MAX_TEXT_SCAN_BYTES) continue;
    const local = readLocalZipEntry(buf, localOffset, method, compressedSize);
    if (local) entries.set(name, local);
  }
  return entries;
}

function findEndOfCentralDirectory(buf) {
  const start = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function isSafeXmindEntry(name) {
  if (!name || name.includes("..") || path.isAbsolute(name)) return false;
  return /(^|\/)(content\.json|content\.xml)$/i.test(name);
}

function readLocalZipEntry(buf, offset, method, compressedSize) {
  if (offset < 0 || offset > buf.length - 30 || buf.readUInt32LE(offset) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buf.length) return null;
  const data = buf.subarray(dataStart, dataEnd);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  return null;
}

function extractRegexValues(text, re) {
  const out = [];
  for (const match of text.matchAll(re)) safePushUnique(out, match[1]);
  return out;
}

function extractReadableStrings(buf) {
  const ascii = [];
  const text = buf.toString("latin1");
  const re = /[\x20-\x7e]{4,}/g;
  for (const match of text.matchAll(re)) safePushUnique(ascii, match[0]);

  const utf16 = [];
  const wide = buf.toString("utf16le");
  for (const match of wide.matchAll(/[\x20-\x7e]{4,}/g)) safePushUnique(utf16, match[0]);

  return [...ascii, ...utf16].slice(0, MAX_SECTION_ITEMS);
}

function formatHexHeader(buf) {
  return [...buf].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function sumCounts(items) {
  return items.reduce((sum, item) => {
    const match = /:\s*(\d+)$/.exec(item);
    return sum + (match ? Number(match[1]) : 0);
  }, 0);
}
