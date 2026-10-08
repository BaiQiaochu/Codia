// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { xlsxToText } from "../../../shared/xlsx-utils.ts";

const DEFAULT_TITLE = "Mind Map";
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_PROMPT_TEXT = 12_000;

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildStoredZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export function normalizeMindMapTopic(input, fallbackTitle = DEFAULT_TITLE) {
  if (typeof input === "string") {
    return { title: input.trim() || fallbackTitle, children: [] };
  }
  if (!input || typeof input !== "object") {
    return { title: fallbackTitle, children: [] };
  }
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
  const title = String(input.title || input.name || "").trim() || fallbackTitle;
  const rawChildren = Array.isArray(input.children) ? input.children : [];
  const topic = {
    title,
    children: rawChildren
      .map((child) => normalizeMindMapTopic(child, "Topic"))
      .filter((child) => child.title),
  };
  if (id) topic.id = id;
  return topic;
}

function xmindTopicToWorkbookTopic(topic, idPrefix = "topic", indexPath = "0") {
  const children = Array.isArray(topic.children)
    ? topic.children.map((child, index) => xmindTopicToWorkbookTopic(child, idPrefix, `${indexPath}-${index}`))
    : [];
  const result = {
    id: topic.id || `${idPrefix}-${indexPath}`,
    title: topic.title,
  };
  if (children.length > 0) {
    result.children = { attached: children };
  }
  return result;
}

export function buildXmindWorkbook(title, topics = []) {
  const root = normalizeMindMapTopic(
    topics && typeof topics === "object" && !Array.isArray(topics)
      ? topics
      : { title, children: Array.isArray(topics) ? topics : [] },
    String(title || "").trim() || DEFAULT_TITLE,
  );
  const content = JSON.stringify([{
    id: "sheet-1",
    title: root.title,
    rootTopic: xmindTopicToWorkbookTopic(root, "root-topic"),
  }]);
  return buildStoredZip([["content.json", content]]);
}

export function sanitizeXmindName(name, fallbackBase = DEFAULT_TITLE) {
  const base = path.basename(String(name || "").trim() || fallbackBase).replace(/\.[^.]+$/, "");
  return `${base || fallbackBase}.xmind`;
}

export function uniqueFileName(dir, desiredName) {
  const parsed = path.parse(desiredName);
  let candidate = desiredName;
  let index = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${parsed.name} ${index}${parsed.ext}`;
    index += 1;
  }
  return candidate;
}

export function resolveMindMapOutputDir(input = {}, ctx = {}, options = {}) {
  const explicitDir = String(input?.outputDir || input?.dir || "").trim();
  if (explicitDir) return path.resolve(explicitDir);

  const workspaceCandidates = [
    typeof ctx?.getWorkspaceDir === "function" ? ctx.getWorkspaceDir() : null,
    ctx?.cwd,
    ctx?.workspace,
    ctx?.deskCwd,
    ctx?.defaultDeskCwd,
    ctx?.homeCwd,
  ];
  for (const candidate of workspaceCandidates) {
    const value = String(candidate || "").trim();
    if (value) return path.resolve(value);
  }

  const baseDir = path.resolve(String(ctx?.dataDir || process.cwd()));
  return options.fallbackSubdir ? path.join(baseDir, options.fallbackSubdir) : baseDir;
}

function plainTextFromBuffer(filePath, maxBytes = 256 * 1024) {
  const buffer = fs.readFileSync(filePath).subarray(0, maxBytes);
  const head = buffer.subarray(0, Math.min(buffer.length, 8192));
  const nulCount = head.reduce((sum, byte) => sum + (byte === 0 ? 1 : 0), 0);
  if (head.length > 0 && nulCount > head.length / 8) return "";
  return buffer.toString("utf8").replaceAll(String.fromCharCode(0), "\n");
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(h[1-6]|p|li|tr|div|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractDocumentTextForMindmap(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result?.value || "";
  }
  if (ext === "xlsx" || ext === "xls") {
    return await xlsxToText(filePath);
  }
  if (ext === "pdf") {
    return stripHtmlToText(plainTextFromBuffer(filePath, MAX_DOCUMENT_BYTES));
  }
  return plainTextFromBuffer(filePath);
}

function cleanTopicTitle(value) {
  return String(value || "")
    .replace(/^\s{0,8}(#{1,6}|\d+[.)]|[-*+])\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function localMindmapFromDocument(title, text) {
  const root = { title: cleanTopicTitle(title) || DEFAULT_TITLE, children: [] };
  const stack = [{ level: 0, topic: root, kind: "root" }];
  const paragraphs = [];

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const numbered = /^(\d+(?:\.\d+)*|[一二三四五六七八九十]+)[.)、]\s+(.+)$/.exec(line);
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    let level = 1;
    let label = "";
    if (heading) {
      level = heading[1].length;
      label = heading[2];
    } else if (numbered) {
      level = Math.min(4, numbered[1].split(".").length + 1);
      label = numbered[2];
    } else if (bullet) {
      level = Math.min(4, stack[stack.length - 1]?.level + 1 || 2);
      label = bullet[1];
    } else {
      paragraphs.push(line);
      continue;
    }

    if (bullet) {
      const current = stack[stack.length - 1];
      level = current?.kind === "bullet" ? current.level : Math.min(4, (current?.level || 1) + 1);
    }

    const topic = { title: cleanTopicTitle(label), children: [] };
    if (!topic.title) continue;
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].topic.children.push(topic);
    stack.push({ level, topic, kind: bullet ? "bullet" : "heading" });
  }

  if (root.children.length === 0) {
    for (const paragraph of paragraphs.slice(0, 12)) {
      const itemTitle = cleanTopicTitle(paragraph);
      if (itemTitle) root.children.push({ title: itemTitle, children: [] });
    }
  }
  if (root.children.length === 0) {
    root.children.push({ title: "Summary", children: [] });
  }
  return root;
}

function parseMindmapJson(raw, fallbackTitle) {
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const topics = Array.isArray(parsed.topics) ? parsed.topics : parsed.children;
    return normalizeMindMapTopic({
      title: parsed.title || fallbackTitle,
      children: Array.isArray(topics) ? topics : [],
    }, fallbackTitle);
  } catch {
    return null;
  }
}

function utilityConfigFromEngine(engine) {
  let utilConfig = null;
  try {
    utilConfig = engine?.resolveUtilityConfig?.();
  } catch {
    utilConfig = null;
  }
  const model = utilConfig?.utility_large || utilConfig?.utility;
  const apiKey = utilConfig?.large_api_key || utilConfig?.api_key;
  const baseUrl = utilConfig?.large_base_url || utilConfig?.base_url;
  const api = utilConfig?.large_api || utilConfig?.api;
  if (!model || !apiKey || !baseUrl || !api) return null;
  return {
    api,
    model,
    apiKey,
    baseUrl,
    usageLedger: utilConfig?.usageLedger ?? engine?.usageLedger,
    usageContext: {
      source: {
        subsystem: "utility",
        operation: "mindmap_from_document",
        surface: "plugin",
        trigger: "manual",
      },
      attribution: {
        kind: "utility",
        agentId: utilConfig?.usageAgentId ?? engine?.currentAgentId ?? null,
      },
    },
  };
}

async function callUtilityWithBus(ctx, title, text) {
  if (typeof ctx?.bus?.request !== "function") return null;
  const result = await ctx.bus.request("utility:call-text", {
    agentId: ctx.agentId || null,
    systemPrompt: [
      "Create a concise mind map from explicitly provided document text only.",
      "Do not use chat history, session history, memory, or external context.",
      "Return strict JSON: {\"title\":\"...\",\"topics\":[{\"title\":\"...\",\"children\":[...]}]}",
      "Limit to 6 top-level topics and 4 children per topic.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: `Document title: ${title}\n\nDocument content:\n${String(text || "").slice(0, MAX_PROMPT_TEXT)}`,
    }],
    temperature: 0.2,
    maxTokens: 900,
    timeoutMs: 45_000,
  });
  return typeof result === "string" ? result : result?.text;
}

async function callUtilityWithEngine(engine, callText, title, text) {
  if (typeof callText !== "function") return null;
  const cfg = utilityConfigFromEngine(engine);
  if (!cfg) return null;
  return await callText({
    ...cfg,
    temperature: 0.2,
    maxTokens: 900,
    timeoutMs: 45_000,
    systemPrompt: [
      "Create a concise mind map from one document only.",
      "Do not use chat/session history or external context.",
      "Return strict JSON: {\"title\":\"...\",\"topics\":[{\"title\":\"...\",\"children\":[...]}]}",
      "Limit to 6 top-level topics and 4 children per topic.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: `Document title: ${title}\n\nDocument content:\n${String(text || "").slice(0, MAX_PROMPT_TEXT)}`,
    }],
  });
}

export async function generateMindmapFromDocument(engineOrCtx, title, text, options = {}) {
  const fallback = localMindmapFromDocument(title, text);
  try {
    const raw = options.callText
      ? await callUtilityWithEngine(engineOrCtx, options.callText, title, text)
      : await callUtilityWithBus(engineOrCtx, title, text);
    return parseMindmapJson(raw, fallback.title) || fallback;
  } catch (err) {
    options.log?.warn?.(`[mind-map] document mind map LLM failed, using local fallback: ${err?.message || err}`);
    return fallback;
  }
}

export function normalizeBuildDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents
    .map((item, index) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return { title: `Document ${index + 1}`, text };
      }
      if (!item || typeof item !== "object") return null;
      const text = String(item.text ?? item.content ?? item.body ?? "").trim();
      if (!text) return null;
      return {
        title: String(item.title ?? item.name ?? `Document ${index + 1}`).trim(),
        text,
      };
    })
    .filter(Boolean);
}

export async function collectExplicitMindmapInput(input) {
  const explicitText = String(input?.text || "").trim();
  const documents = normalizeBuildDocuments(input?.documents);
  if (explicitText) {
    return {
      title: String(input?.title || "Mind Map").trim() || DEFAULT_TITLE,
      text: explicitText,
      sourcePath: "",
    };
  }
  if (documents.length > 0) {
    return {
      title: String(input?.title || documents[0].title || "Mind Map").trim() || DEFAULT_TITLE,
      text: documents.map((doc) => `# ${doc.title}\n${doc.text}`).join("\n\n"),
      sourcePath: "",
    };
  }
  const filePath = String(input?.filePath || input?.path || "").trim();
  if (filePath) {
    const text = await extractDocumentTextForMindmap(filePath);
    return {
      title: String(input?.title || path.basename(filePath).replace(/\.[^.]+$/i, "") || "Mind Map").trim() || DEFAULT_TITLE,
      text,
      sourcePath: filePath,
    };
  }
  return null;
}
