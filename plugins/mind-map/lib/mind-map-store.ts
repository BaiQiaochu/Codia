// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import darkWatermark from "../../../shared/dark-watermark.cjs";
import {
  buildXmindWorkbook,
  normalizeMindMapTopic,
  sanitizeXmindName,
  uniqueFileName,
} from "./mind-map-operations.ts";

const { watermarkGeneratedFileSync } = darkWatermark;

const MAX_XMIND_ENTRY_BYTES = 4 * 1024 * 1024;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeFilePath(filePath, baseDir) {
  const raw = String(filePath || "").trim();
  if (!raw) throw new Error("file path is required");
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(baseDir, raw));
}

function childrenFromXmindTopic(topic) {
  const children = topic?.children;
  const groups = [];
  if (Array.isArray(children?.attached)) groups.push(children.attached);
  if (Array.isArray(children?.detached)) groups.push(children.detached);
  if (Array.isArray(children)) groups.push(children);
  return groups.flat();
}

function xmindTopicToTree(topic, fallbackTitle = "Mind Map", indexPath = "0") {
  const id = String(topic?.id || `topic-${indexPath}`);
  const title = String(topic?.title || fallbackTitle).trim() || fallbackTitle;
  return {
    id,
    title,
    children: childrenFromXmindTopic(topic)
      .map((child, index) => xmindTopicToTree(child, "Topic", `${indexPath}-${index}`))
      .filter((child) => child.title),
  };
}

function ensureTreeIds(topic, indexPath = "0") {
  const normalized = normalizeMindMapTopic(topic, indexPath === "0" ? "Mind Map" : "Topic");
  normalized.id = String(topic?.id || normalized.id || `topic-${indexPath}`);
  normalized.children = normalized.children.map((child, index) => ensureTreeIds(child, `${indexPath}-${index}`));
  return normalized;
}

function collectJsonTree(raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.root) return ensureTreeIds(parsed.root);
  return ensureTreeIds(parsed);
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

    if (!isSafeXmindEntry(name) || compressedSize > MAX_XMIND_ENTRY_BYTES || uncompressedSize > MAX_XMIND_ENTRY_BYTES) continue;
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

function readXmindTree(filePath) {
  const entries = readZipEntries(filePath);
  const content = entries.get("content.json") || entries.get("content.json".toUpperCase());
  if (!content) throw new Error("XMind content.json was not found");
  const parsed = JSON.parse(content.toString("utf8"));
  const sheet = Array.isArray(parsed) ? parsed[0] : parsed;
  return xmindTopicToTree(sheet?.rootTopic, sheet?.title || "Mind Map");
}

function findNode(topic, id) {
  if (!topic || !id) return null;
  if (topic.id === id) return topic;
  for (const child of topic.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function removeNode(topic, id) {
  const children = Array.isArray(topic.children) ? topic.children : [];
  const index = children.findIndex((child) => child.id === id);
  if (index >= 0) {
    children.splice(index, 1);
    return true;
  }
  return children.some((child) => removeNode(child, id));
}

function createNodeId() {
  return `topic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function watermarkMindMapFile(filePath) {
  watermarkGeneratedFileSync({
    filePath,
    source: "mind_map",
    origin: "plugin_generated",
    storageKind: "plugin_generated",
  });
}

export class MindMapStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir || process.cwd());
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  createBlank(name = "Mind Map.xmind", title = "Mind Map", options = {}) {
    const dir = path.resolve(options.dir || this.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = options.unique === false
      ? sanitizeXmindName(name)
      : uniqueFileName(dir, sanitizeXmindName(name));
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buildXmindWorkbook(title || fileName.replace(/\.xmind$/i, "")));
    watermarkMindMapFile(filePath);
    return filePath;
  }

  createFromTree(filePath, root) {
    const resolved = normalizeFilePath(filePath, this.dataDir);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.write(resolved, root);
    return resolved;
  }

  read(filePath) {
    const resolved = normalizeFilePath(filePath, this.dataDir);
    const ext = path.extname(resolved).toLowerCase();
    const root = ext === ".json"
      ? collectJsonTree(fs.readFileSync(resolved, "utf8"))
      : readXmindTree(resolved);
    return { filePath: resolved, fileName: path.basename(resolved), root };
  }

  write(filePath, root) {
    const resolved = normalizeFilePath(filePath, this.dataDir);
    const normalized = ensureTreeIds(root);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (path.extname(resolved).toLowerCase() === ".json") {
      fs.writeFileSync(resolved, JSON.stringify({ root: normalized }, null, 2) + "\n", "utf8");
    } else {
      fs.writeFileSync(resolved, buildXmindWorkbook(normalized.title, normalized));
    }
    watermarkMindMapFile(resolved);
    return { filePath: resolved, fileName: path.basename(resolved), root: clone(normalized) };
  }

  addNode(filePath, parentId, title = "New Topic") {
    const current = this.read(filePath);
    const parent = findNode(current.root, parentId);
    if (!parent) throw new Error("parent node not found");
    const node = { id: createNodeId(), title: String(title || "New Topic").trim() || "New Topic", children: [] };
    parent.children = Array.isArray(parent.children) ? parent.children : [];
    parent.children.push(node);
    const saved = this.write(current.filePath, current.root);
    return { ...saved, node: clone(node) };
  }

  renameNode(filePath, nodeId, title) {
    const nextTitle = String(title || "").trim();
    if (!nextTitle) throw new Error("title is required");
    const current = this.read(filePath);
    const node = findNode(current.root, nodeId);
    if (!node) throw new Error("node not found");
    node.title = nextTitle;
    return this.write(current.filePath, current.root);
  }

  deleteNode(filePath, nodeId) {
    const current = this.read(filePath);
    if (current.root.id === nodeId) throw new Error("root node cannot be deleted");
    if (!removeNode(current.root, nodeId)) throw new Error("node not found");
    return this.write(current.filePath, current.root);
  }
}