export const SESSION_PERMISSION_MODES = Object.freeze({
  AUTO: "auto",
  OPERATE: "operate",
  ASK: "ask",
  READ_ONLY: "read_only",
});

export const DEFAULT_SESSION_PERMISSION_MODE = SESSION_PERMISSION_MODES.ASK;
const BRIDGE_PERMISSION_MODE_VALUES = new Set([
  SESSION_PERMISSION_MODES.AUTO,
  SESSION_PERMISSION_MODES.OPERATE,
  SESSION_PERMISSION_MODES.READ_ONLY,
] as string[]);

const INFORMATION_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "search_memory",
  "recall_experience",
  "current_status",
]);

const SIDE_EFFECT_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "computer",
  "cron",
  "dm",
  "channel",
  "install_skill",
  "update_settings",
  "todo_write",
  "create_artifact",
  "stage_files",
  "present_files",
  "subagent",
  "workflow",
  "notify",
  "record_experience",
  "pin_memory",
  "unpin_memory",
  "session_folders",
]);

const SUBAGENT_BLOCKED_TOOLS = new Set([
  "subagent",
  "workflow",
  "pin_memory",
  "unpin_memory",
  "record_experience",
  "cron",
  "channel",
  "dm",
  "notify",
  "install_skill",
  "update_settings",
  "session_folders",
]);

const BROWSER_READ_ACTIONS = new Set([
  "start",
  "navigate",
  "snapshot",
  "screenshot",
  "scroll",
  "wait",
  "show",
  "stop",
]);

const TERMINAL_READ_ACTIONS = new Set([
  "read",
  "list",
]);

const FILE_READ_ACTIONS = new Set([
  "stat",
]);

type SessionPermissionMode = typeof SESSION_PERMISSION_MODES[keyof typeof SESSION_PERMISSION_MODES];

type PermissionModeInput = {
  permissionMode?: string;
  accessMode?: string;
  planMode?: boolean;
  readOnly?: boolean;
};

type PermissionContext = {
  isSubagent?: boolean;
  requireInteractiveApproval?: boolean;
};

type ClassifySessionPermissionInput = {
  mode?: string | PermissionModeInput;
  toolName?: string;
  params?: Record<string, any>;
  context?: PermissionContext;
};

type BlockedOptions = {
  code?: string;
  message?: string;
};

export function normalizeSessionPermissionMode(raw: string | PermissionModeInput | null | undefined): SessionPermissionMode {
  if (typeof raw === "string") return normalizeSessionPermissionMode({ permissionMode: raw });
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.AUTO) return SESSION_PERMISSION_MODES.AUTO;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.OPERATE) return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.ASK) return SESSION_PERMISSION_MODES.ASK;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.accessMode === "operate") return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.accessMode === "read_only") return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.planMode === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return DEFAULT_SESSION_PERMISSION_MODE;
}

export function normalizeBridgePermissionMode(raw: string | PermissionModeInput | null | undefined): SessionPermissionMode {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (typeof source === "string" && BRIDGE_PERMISSION_MODE_VALUES.has(source)) return source as SessionPermissionMode;
  if (raw && typeof raw !== "string" && raw.readOnly === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function legacyAccessModeFromPermissionMode(mode: string | PermissionModeInput | null | undefined) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY ? "read_only" : "operate";
}

export function isReadOnlyPermissionMode(mode: string | PermissionModeInput | null | undefined) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY;
}

function blocked(toolName: string, { code = "ACTION_BLOCKED_BY_READ_ONLY", message }: BlockedOptions = {}) {
  return {
    action: "deny",
    code,
    message: message || `${toolName} is blocked in read-only mode.`,
    details: { toolName },
  };
}

function prompt(toolName: string) {
  return {
    action: "prompt",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function review(toolName: string) {
  return {
    action: "review",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function classifyBrowserAction(mode: SessionPermissionMode, action?: string) {
  if (BROWSER_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blocked("browser");
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("browser");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("browser");
  return { action: "allow" };
}

function classifyTerminalAction(mode: SessionPermissionMode, action?: string) {
  if (TERMINAL_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blocked("terminal");
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("terminal");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("terminal");
  return { action: "allow" };
}

function classifySessionFoldersAction(mode: SessionPermissionMode, action?: string) {
  if (action === "list") return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blocked("session_folders");
  return { action: "allow" };
}

function classifyFileAction(mode: SessionPermissionMode, action?: string) {
  if (FILE_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blocked("file");
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("file");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("file");
  return { action: "allow" };
}

export function classifySessionPermission({ mode, toolName, params, context }: ClassifySessionPermissionInput = {}) {
  let normalized = normalizeSessionPermissionMode(mode);
  const name = typeof toolName === "string" ? toolName : "";
  if (!name) return { action: "allow" };
  if (context?.isSubagent && SUBAGENT_BLOCKED_TOOLS.has(name)) {
    return blocked(name, {
      code: "ACTION_BLOCKED_IN_SUBAGENT",
      message: `${name} is not available inside a subagent.`,
    });
  }
  if (context?.isSubagent && !context.requireInteractiveApproval && (
    normalized === SESSION_PERMISSION_MODES.ASK
    || normalized === SESSION_PERMISSION_MODES.AUTO
  )) {
    normalized = SESSION_PERMISSION_MODES.OPERATE;
  }
  if (INFORMATION_TOOLS.has(name)) return { action: "allow" };
  if (name === "browser") return classifyBrowserAction(normalized, params?.action);
  if (name === "terminal") return classifyTerminalAction(normalized, params?.action);
  if (name === "session_folders") return classifySessionFoldersAction(normalized, params?.action);
  if (name === "file") return classifyFileAction(normalized, params?.action);
  if (normalized === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) return blocked(name);
  if (normalized === SESSION_PERMISSION_MODES.AUTO) return review(name);
  if (SIDE_EFFECT_TOOLS.has(name)) return prompt(name);
  return prompt(name);
}
