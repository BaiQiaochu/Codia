// @ts-nocheck
import { StringEnum, Type } from "../pi-sdk/index.ts";
import { getAppearanceStatus } from "./appearance-status.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { toolError, toolOk } from "./tool-result.ts";
import path from "path";

const DAY_BOUNDARY_HOUR = 4;

const DEFAULT_USAGE =
  "Call action=list to discover available status keys. Then call action=get with the smallest necessary key. Do not request unrelated status.";

function resolveTimezone(raw) {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const candidate = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDateTime(parts) {
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function getUtcOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const value = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  if (value === "GMT") return "+00:00";
  return value.replace(/^GMT/, "");
}

function getLogicalDate(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  let year = Number(parts.year);
  let month = Number(parts.month);
  let day = Number(parts.day);

  if (Number(parts.hour) < DAY_BOUNDARY_HOUR) {
    const previous = new Date(Date.UTC(year, month - 1, day));
    previous.setUTCDate(previous.getUTCDate() - 1);
    year = previous.getUTCFullYear();
    month = previous.getUTCMonth() + 1;
    day = previous.getUTCDate();
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function modelSummary(model) {
  if (!model) {
    return { id: null, provider: null, name: null };
  }
  return {
    id: model.id || null,
    provider: model.provider || null,
    name: model.name || model.id || null,
  };
}

function agentSummary(agent) {
  if (!agent) {
    return { id: null, name: null };
  }
  return {
    id: agent.id || null,
    name: agent.agentName || agent.config?.agent?.name || agent.id || null,
  };
}

function provider(key, description, get) {
  return { key, description, get };
}

function statusOutput(payload, contentBlocks = [], details = {}) {
  return {
    __currentStatusOutput: true,
    payload,
    contentBlocks,
    details,
  };
}

function isStatusOutput(value) {
  return value?.__currentStatusOutput === true;
}

function normalizeUiContext(value) {
  const ctx = value && typeof value === "object" ? value : {};
  return {
    currentViewed: typeof ctx.currentViewed === "string" && ctx.currentViewed ? ctx.currentViewed : null,
    activeFile: typeof ctx.activeFile === "string" && ctx.activeFile ? ctx.activeFile : null,
    activePreview: typeof ctx.activePreview === "string" && ctx.activePreview ? ctx.activePreview : null,
    pinnedFiles: Array.isArray(ctx.pinnedFiles)
      ? ctx.pinnedFiles.filter((item) => typeof item === "string" && item)
      : [],
  };
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeOperations(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item)
    : [];
}

function sessionFileRef(fileId) {
  return fileId ? { kind: "session-file", fileId } : null;
}

function writableLocalRefForSessionFile(source, status) {
  const origin = nullableString(source.origin);
  const filePath = nullableString(source.filePath);
  if (origin !== "agent_write" && origin !== "agent_edit") return null;
  if (status === "expired" || source.isDirectory === true) return null;
  if (!filePath || !path.isAbsolute(filePath)) return null;
  return { kind: "local-file", path: filePath };
}

function normalizeSessionFile(file) {
  const source = file && typeof file === "object" ? file : {};
  const fileId = nullableString(source.fileId || source.id);
  const status = nullableString(source.status) || "available";
  return {
    fileId,
    sessionFileRef: sessionFileRef(fileId),
    writableLocalRef: writableLocalRefForSessionFile(source, status),
    label: nullableString(source.label || source.displayName || source.filename || source.filePath),
    displayName: nullableString(source.displayName),
    filename: nullableString(source.filename),
    ext: nullableString(source.ext),
    kind: nullableString(source.kind),
    mime: nullableString(source.mime),
    size: nullableNumber(source.size),
    origin: nullableString(source.origin),
    operations: normalizeOperations(source.operations),
    storageKind: nullableString(source.storageKind),
    status,
    missingAt: nullableNumber(source.missingAt),
    createdAt: nullableNumber(source.createdAt),
    isDirectory: source.isDirectory === true,
    filePath: nullableString(source.filePath),
    realPath: nullableString(source.realPath),
  };
}

function normalizeBridgeContext(value) {
  const source = value && typeof value === "object" ? value : {};
  if (source.isBridgeSession !== true) {
    return { isBridgeSession: false };
  }
  const notificationHint = source.notificationHint && typeof source.notificationHint === "object"
    ? {
        channels: Array.isArray(source.notificationHint.channels)
          ? source.notificationHint.channels.filter((item) => typeof item === "string" && item)
          : [],
        bridgePlatforms: Array.isArray(source.notificationHint.bridgePlatforms)
          ? source.notificationHint.bridgePlatforms.filter((item) => typeof item === "string" && item)
          : [],
        contextPolicy: nullableString(source.notificationHint.contextPolicy),
      }
    : null;
  return {
    isBridgeSession: true,
    platform: nullableString(source.platform),
    platformLabel: nullableString(source.platformLabel),
    chatType: nullableString(source.chatType),
    role: nullableString(source.role),
    sessionKey: nullableString(source.sessionKey),
    agentId: nullableString(source.agentId),
    userId: nullableString(source.userId),
    chatId: nullableString(source.chatId),
    notificationHint,
  };
}

function normalizeSubagentThread(thread) {
  const source = thread && typeof thread === "object" ? thread : {};
  return {
    threadId: nullableString(source.threadId),
    agentId: nullableString(source.agentId),
    agentName: nullableString(source.agentName),
    label: nullableString(source.label),
    access: nullableString(source.access),
    status: nullableString(source.status),
    lastRunStatus: nullableString(source.lastRunStatus),
    childSessionPath: nullableString(source.childSessionPath),
    summary: nullableString(source.summary),
    runCount: nullableNumber(source.runCount),
    lastRunAt: nullableString(source.lastRunAt),
    updatedAt: nullableString(source.updatedAt),
  };
}

function sessionFilesStatus(sessionPath, deps) {
  if (typeof deps.listSessionFiles !== "function") {
    return {
      session_files: {
        sessionPath: sessionPath || null,
        registryAvailable: false,
        files: [],
        error: "session file registry unavailable",
      },
    };
  }
  if (!sessionPath) {
    return {
      session_files: {
        sessionPath: null,
        registryAvailable: true,
        files: [],
      },
    };
  }
  return {
    session_files: {
      sessionPath,
      registryAvailable: true,
      files: deps.listSessionFiles(sessionPath).map(normalizeSessionFile),
    },
  };
}

function normalizeProvider(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.key !== "string" || !item.key.trim()) return null;
  if (typeof item.get !== "function") return null;
  return {
    key: item.key.trim(),
    description: typeof item.description === "string" ? item.description : "",
    get: item.get,
  };
}

export function createCurrentStatusRegistry(deps = {}) {
  const getNow = () => {
    const value = deps.now?.();
    return value instanceof Date ? value : new Date();
  };
  const getTimezone = () => resolveTimezone(deps.getTimezone?.());
  const getStatusModel = ({ sessionPath, ctx } = {}) => (
    ctx?.model
    || (sessionPath ? deps.getSessionModel?.(sessionPath) : null)
    || deps.getCurrentModel?.()
    || null
  );

  const providers = [
    provider(
      "time",
      "Current real time, configured timezone, local datetime, and UTC offset.",
      async () => {
        const now = getNow();
        const timeZone = getTimezone();
        return {
          time: {
            iso: now.toISOString(),
            timezone: timeZone,
            localDateTime: formatLocalDateTime(zonedParts(now, timeZone)),
            utcOffset: getUtcOffset(now, timeZone),
          },
        };
      },
    ),
    provider(
      "logical_date",
      "Logical date. The day starts at 04:00 in the configured timezone.",
      async () => {
        const now = getNow();
        const timeZone = getTimezone();
        return {
          logical_date: {
            date: getLogicalDate(now, timeZone),
            timezone: timeZone,
            dayBoundaryHour: DAY_BOUNDARY_HOUR,
          },
        };
      },
    ),
    provider(
      "agent",
      "Current agent identity: stable id and display name.",
      async () => ({ agent: agentSummary(deps.getAgent?.()) }),
    ),
    provider(
      "appearance",
      "Current user and agent custom avatar appearance. Uses auxiliary vision summaries when available; if no summary is available and the current model can read images directly, returns avatar image blocks. Default built-in avatars count as no custom avatar.",
      async ({ sessionPath, ctx, signal }) => {
        const result = await getAppearanceStatus({
          agent: deps.getAgent?.(),
          userDir: deps.getUserDir?.(),
          visionBridge: deps.getVisionBridge?.(),
          currentModel: getStatusModel({ sessionPath, ctx }),
          sessionPath,
          signal,
        });
        return statusOutput(result.payload, result.contentBlocks, result.details);
      },
    ),
    provider(
      "model",
      "Current session model when available; otherwise the current selected chat model.",
      async ({ sessionPath }) => ({
        model: modelSummary(
          (sessionPath ? deps.getSessionModel?.(sessionPath) : null)
            || deps.getCurrentModel?.()
            || null,
        ),
      }),
    ),
    provider(
      "ui_context",
      "User's current visible UI context for resolving references to what they are looking at. Returns the current viewed folder, active file or preview title, and pinned viewer files. Call this before working on requests that mention this file, here, current, open, visible, selected, pinned, current file, or current folder.",
      async ({ sessionPath }) => ({
        ui_context: normalizeUiContext(deps.getUiContext?.(sessionPath) || null),
      }),
    ),
    provider(
      "session_files",
      "Current session's registered files. Use this before reusing screenshots, uploads, plugin outputs, or other files produced in the conversation; it returns file ids, labels, lifecycle metadata, and local paths.",
      async ({ sessionPath }) => sessionFilesStatus(sessionPath, deps),
    ),
    provider(
      "bridge_context",
      "Current Bridge platform context for resolving references such as here, this chat, this platform, or notification delivery targets. Returns isBridgeSession=false outside Bridge sessions.",
      async ({ sessionPath }) => ({
        bridge_context: normalizeBridgeContext(deps.getBridgeContext?.(sessionPath) || null),
      }),
    ),
    provider(
      "subagents",
      "Open direct subagent instances for the current session. Use this before deciding whether to continue, close, or create a subagent colleague.",
      async ({ sessionPath }) => ({
        subagents: {
          sessionPath: sessionPath || null,
          open: typeof deps.listOpenSubagentThreads === "function" && sessionPath
            ? deps.listOpenSubagentThreads(sessionPath).map(normalizeSubagentThread)
            : [],
        },
      }),
    ),
  ];

  for (const extra of deps.providers || []) {
    const normalized = normalizeProvider(extra);
    if (!normalized) continue;
    const index = providers.findIndex((item) => item.key === normalized.key);
    if (index === -1) providers.push(normalized);
    else providers[index] = normalized;
  }

  return new Map(providers.map((item) => [item.key, item]));
}

export function createCurrentStatusTool(deps = {}) {
  const registry = createCurrentStatusRegistry(deps);
  return {
    name: "current_status",
    label: "Current Status",
    description:
      "Lightweight current-environment status. Use it to check fresh state such as time, logical date, agent identity, user/agent avatar appearance, model identity, Bridge platform context, and the user's visible UI context. IMPORTANT: The date/time shown in the system prompt is a snapshot from when the session was created and may be outdated. For precise current time, scheduling, reminders, date calculations that need clock time, greetings, or any case where hour/minute matters, call this tool with action=\"get\", key=\"time\". Use key=\"logical_date\" only when you need to know which calendar day this app should treat as today under the 4:00 boundary; it does not return hour/minute/second. Use key=\"appearance\" when the user asks what the user or current agent looks like. When the user refers to this file, here, the current/open/visible/selected item, the pinned window, current Bridge chat/platform, session files, or the current folder, call this tool first to resolve the reference.",
    parameters: Type.Object({
      action: StringEnum(["list", "get"], {
        description: "list returns available status keys; get returns one status key value.",
      }),
      key: Type.Optional(Type.String({
        description: "Status key to fetch when action=get. Common keys: time, logical_date, agent, appearance, model, ui_context, session_files, bridge_context, subagents. Use bridge_context for references to the current Bridge platform/chat. Use subagents before continuing or closing a subagent instance.",
      })),
    }),
    execute: async (_toolCallId, params = {}, signal, _onUpdate, ctx) => {
      const action = params.action || "list";
      if (action === "list") {
        return toolOk(JSON.stringify({
          available: [...registry.values()].map((item) => ({
            key: item.key,
            description: item.description,
          })),
          usage: DEFAULT_USAGE,
        }, null, 2));
      }

      const key = typeof params.key === "string" ? params.key.trim() : "";
      if (!key) {
        return toolError("current_status get requires a key. Call action=list to see available keys.", {
          errorCode: "STATUS_KEY_REQUIRED",
        });
      }
      const item = registry.get(key);
      if (!item) {
        return toolError(`Unknown status key: ${key}. Call action=list to see available keys.`, {
          errorCode: "UNKNOWN_STATUS_KEY",
          key,
        });
      }

      const sessionPath = getToolSessionPath(ctx);
      const payload = await item.get({ sessionPath, ctx, signal });
      if (isStatusOutput(payload)) {
        return {
          content: [
            { type: "text", text: JSON.stringify(payload.payload, null, 2) },
            ...payload.contentBlocks,
          ],
          details: {
            action,
            key,
            ...payload.details,
          },
        };
      }
      return toolOk(JSON.stringify(payload, null, 2), { action, key });
    },
  };
}
