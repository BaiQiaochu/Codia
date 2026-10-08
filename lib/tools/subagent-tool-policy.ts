// @ts-nocheck
/**
  *
  *
  *
  *
  *
 */
import {
  SESSION_PERMISSION_MODES,
  isReadOnlyPermissionMode,
} from "../../core/session-permission-mode.ts";

const STRIP_CUSTOM_TOOLS = ["web_search", "web_fetch", "todo_write", "browser"];
const STRIP_BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const STRIP_BUILTIN_READONLY = ["read", "grep", "find", "ls"];
export const SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY = "SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY";

export class SubagentAccessDeniedError extends Error {
  constructor(message = "Cannot grant subagent write access from a read-only parent session.") {
    super(message);
    this.name = "SubagentAccessDeniedError";
    this.code = SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY;
  }
}

/** */
export function resolveSubagentToolStrategy() {
  const envValue = process.env.GSAP_SUBAGENT_TOOL_STRATEGY
    || process.env.HANA_SUBAGENT_TOOL_STRATEGY;
  return envValue === "strip" ? "strip" : "intercept";
}

/**
 * 省略 access 时的继承映射：subagent 是后台任务，无法交互确认，所以只有两态- * 只读（READ_ONLY）或可操作（OPERATE）父会话档坍缩到这两态：
 * - 父只读（plan 模式）→ READ_ONLY（用户在只读态派出，subagent 也只读）
  *
  * */
function resolveInheritedMode(parentPermissionMode) {
  return isReadOnlyPermissionMode(parentPermissionMode)
    ? SESSION_PERMISSION_MODES.READ_ONLY
    : SESSION_PERMISSION_MODES.OPERATE;
}

function resolvePermissionMode(access, parentPermissionMode) {
  if (access === "read") return SESSION_PERMISSION_MODES.READ_ONLY;
  if (access === "write") {
    if (isReadOnlyPermissionMode(parentPermissionMode)) {
      throw new SubagentAccessDeniedError();
    }
    return SESSION_PERMISSION_MODES.OPERATE;
  }
  return resolveInheritedMode(parentPermissionMode);
}

/**
  *
 * access-: "read"|"write", // 显式权限档（Codex 式），优先于继承
  *
 * }} [opts]
 * @returns {{
 *   strategy: "intercept"|"strip",
 * customToolFilter: string[]|null, // null = 不剥离自定义工具（给全集- * builtinToolFilter: string[]|null, // null = 不剥离内置工具（给全集）
  *
  *
 */
export function resolveSubagentToolAccess({ access, parentPermissionMode, strategy } = {}) {
  const strat = strategy || resolveSubagentToolStrategy();
  const permissionMode = resolvePermissionMode(access, parentPermissionMode);
  const readOnly = permissionMode === SESSION_PERMISSION_MODES.READ_ONLY;

  if (strat === "strip") {
 // 乙：剥离工具清单（只读档再砍-builtin 只读子集）-
    return {
      strategy: "strip",
      customToolFilter: STRIP_CUSTOM_TOOLS,
      builtinToolFilter: readOnly ? STRIP_BUILTIN_READONLY : STRIP_BUILTIN_TOOLS,
      permissionMode,
      subagentContext: true,
    };
  }

 //
  return {
    strategy: "intercept",
    customToolFilter: null,
    builtinToolFilter: null,
    permissionMode,
    subagentContext: true,
  };
}
