// @ts-nocheck
const MAX_DETAIL_CHARS = 6000;
const MAX_LABEL_CHARS = 80;

const TYPE_LABELS = {
  subagent: "subagent",
  workflow: "workflow",
  "image-generation": "image generation",
  "video-generation": "video generation",
  "audio-generation": "audio generation",
};

const PREFERRED_TEXT_KEYS = [
  "replyText",
  "markdown",
  "text",
  "summary",
  "message",
  "output",
  "content",
  "result",
  "body",
];

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim();
}

function truncateText(value, limit = MAX_DETAIL_CHARS) {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n\n...`;
}

function compactLabel(value, fallback = "") {
  const text = cleanText(value || fallback).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}...` : text;
}

function uniqueParts(parts) {
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const label = compactLabel(part);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function basenamePortable(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function summarizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return "";
  const lines = files
    .slice(0, 8)
    .map((file) => {
      if (typeof file === "string") return `- ${basenamePortable(file) || file}`;
      if (!file || typeof file !== "object") return null;
      const name = file.label || file.displayName || file.filename || basenamePortable(file.filePath || file.realPath) || file.fileId || file.id;
      if (!name) return null;
      const kind = file.kind || file.mime || file.ext || "";
      return `- ${name}${kind ? ` (${kind})` : ""}`;
    })
    .filter(Boolean);
  if (files.length > lines.length) lines.push(`- ${files.length - lines.length} more file(s)`);
  return lines.length ? `Generated files:\n${lines.join("\n")}` : "";
}

function extractTextBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      if (typeof block.text === "string") return block.text;
      if (block.type === "text" && typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatScalar(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function extractReadableResult(value, depth = 0) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map((item) => extractReadableResult(item, depth + 1))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof value !== "object") return "";

  const fileSummary = summarizeFiles(value.sessionFiles || value.files);
  const contentText = extractTextBlocks(value.content);
  if (contentText) return [fileSummary, contentText].filter(Boolean).join("\n\n");

  if (depth < 3) {
    for (const key of PREFERRED_TEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const text = extractReadableResult(value[key], depth + 1);
      if (cleanText(text)) return [fileSummary, text].filter(Boolean).join("\n\n");
    }
  }

  const scalarLines = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === "sessionFiles" || key === "files") continue;
    const scalar = formatScalar(raw);
    if (!cleanText(scalar)) continue;
    scalarLines.push(`- ${key}: ${scalar}`);
    if (scalarLines.length >= 8) break;
  }
  if (scalarLines.length) return [fileSummary, scalarLines.join("\n")].filter(Boolean).join("\n\n");
  if (fileSummary) return fileSummary;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function extractDeferredResultDetailMarkdown({ status, result, reason }) {
  const text = status === "success"
    ? extractReadableResult(result)
    : cleanText(reason) || "The background task did not return a displayable reason.";
  return truncateText(text || "The background task completed without preview text.");
}

function sourceKindFromType(type) {
  if (type === "subagent") return "subagent";
  if (type === "workflow") return "workflow";
  return "tool";
}

function resolveSource(meta = {}, type = "background-task") {
  if (type === "subagent") {
    const agentName = meta.executorAgentNameSnapshot || meta.agentName || meta.requestedAgentNameSnapshot || meta.requestedAgentName;
    const parts = uniqueParts([agentName, meta.label]);
    return { kind: "subagent", label: parts.join(" / ") || TYPE_LABELS.subagent };
  }
  if (type === "workflow") {
    return {
      kind: "workflow",
      label: compactLabel(meta.summary || meta.workflow || meta.name, TYPE_LABELS.workflow),
    };
  }
  return {
    kind: sourceKindFromType(type),
    label: compactLabel(meta.toolName || meta.name || TYPE_LABELS[type] || type || "background task"),
  };
}

function interludeText({ receiverName, source, status }) {
  const receiver = compactLabel(receiverName, "助手");
  if (source.kind === "subagent") {
    if (status === "failed") return `${receiver} received a failed reply from ${source.label}`;
    if (status === "aborted") return `${receiver} stopped the reply from ${source.label}`;
    return `${receiver} received a reply from ${source.label}`;
  }
  if (source.kind === "workflow") {
    if (status === "failed") return `${receiver} received a failed workflow result from ${source.label}`;
    if (status === "aborted") return `${receiver} stopped workflow ${source.label}`;
    return `${receiver} received a workflow result from ${source.label}`;
  }
  if (status === "failed") return `${receiver} did not receive a result from ${source.label}`;
  if (status === "aborted") return `${receiver} stopped the result from ${source.label}`;
  return `${receiver} received a result from ${source.label}`;
}

export function buildDeferredResultInterludeBlock(event, { receiverName = "助手", meta = null } = {}) {
  if (!event?.taskId) return null;
  const mergedMeta = { ...(event.meta || {}), ...(meta || {}) };
  const type = mergedMeta.type || event.type || "background-task";
  const status = event.status === "failed" || event.status === "aborted" ? event.status : "success";
  const deliveryId = cleanText(event.deliveryId);
  const source = resolveSource(mergedMeta, type);
  const previewSessionPath = typeof mergedMeta.sessionPath === "string" && mergedMeta.sessionPath.trim()
    ? mergedMeta.sessionPath
    : null;
  const rawPreviewAgentId = mergedMeta.executorAgentId || mergedMeta.agentId || mergedMeta.requestedAgentId;
  const previewAgentId = typeof rawPreviewAgentId === "string" && rawPreviewAgentId.trim()
    ? rawPreviewAgentId.trim()
    : null;
  const detailMarkdown = extractDeferredResultDetailMarkdown({
    status,
    result: event.result,
    reason: event.reason,
  });

  return {
    type: "interlude",
    id: deliveryId ? `deferred:${event.taskId}:${status}:${deliveryId}` : `deferred:${event.taskId}:${status}`,
    taskId: event.taskId,
    ...(deliveryId ? { deliveryId } : {}),
    variant: "deferred_result",
    timelinePlacement: "after_anchor_message",
    status,
    sourceKind: source.kind,
    sourceLabel: source.label,
    ...(previewSessionPath ? { previewSessionPath } : {}),
    ...(previewAgentId ? { previewAgentId } : {}),
    text: interludeText({ receiverName, source, status }),
    detailMarkdown,
  };
}

export function resolveDeferredReceiverName(engine, sessionPath) {
  const agentId = sessionPath ? engine?.agentIdFromSessionPath?.(sessionPath) || null : null;
  const agent = agentId ? engine?.getAgent?.(agentId) || null : null;
  return agent?.agentName || engine?.agentName || "助手";
}
