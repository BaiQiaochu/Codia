// shared/tool-categories.js
//
// Single source of truth for built-in tool categorization.
//
// Every tool the engine registers (excluding plugin-contributed ones) MUST
// belong to exactly one of the three arrays below. A startup assertion enforces
// this — if a new tool is added without categorization, the engine refuses to
// boot with an error pointing here.
//
// Categories:
//   CORE     — Removing breaks the model. Never user-toggleable, never in UI.
//   STANDARD — Always-on built-in. Not in UI. Move to OPTIONAL to expose a toggle.
//   OPTIONAL — User-toggleable in AgentTab → Tools section. Default: all on.
//
// Plugin-contributed tools (flagged with _pluginId) are NOT part of this
// categorization. Plugin lifecycle is managed by PluginsTab.

export const CORE_TOOL_NAMES = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "search_memory", "pin_memory", "unpin_memory",
  "web_search",
];

export const STANDARD_TOOL_NAMES = [
  "web_fetch",
  "todo_write",
  "hana_card_guide",
  "show_card",
  "create_artifact",
  "hermes_agent",
  "notify",
  "stage_files",
  "file",
  "subagent",
  "subagent_reply",
  "subagent_close",
  "channel",
  "record_experience",
  "recall_experience",
  "check_pending_tasks",
  "current_status",
  "session_folders",
  "wait",
  "stop_task",
  "terminal",
];

export const GLOBAL_TOOL_NAMES = [
  "computer",
];

export const OPTIONAL_TOOL_NAMES = [
  "automation",
  "beautify",
  "browser",
  "cron",
  "dm",
  "install_skill",
  "office",
  "update_settings",
  "workflow",
];

export const PLUGIN_BACKED_OPTIONAL_TOOL_IDS = {
  beautify: "beautify",
  office: "office",
};

const OPTIONAL_TOOL_NAMES_SET = new Set(OPTIONAL_TOOL_NAMES);

type RuntimeToolName = string;
type PluginToolLike = {
  _pluginId?: string;
};
type SettingsAvailableToolOptions = {
  pluginTools?: PluginToolLike[];
};
type ToolSnapshotOptions = {
  extraDisabled?: string[];
};

/**
 * Default-off subset of OPTIONAL_TOOL_NAMES. Applied when agent config has no
 * `tools.disabled` field (i.e., user has never touched tool settings). Both
 * fresh agents and agents upgrading from a pre-feature version hit this path.
 *
 * Must be a subset of OPTIONAL_TOOL_NAMES. The frontend AgentTab keeps a local
 * copy for display defaults; tests/optional-tool-names-drift.test.js guards the
 * two from drifting.
 *
 * Rationale:
 *   dm              — direct-messages between agents; off by default because
 *                     single-agent setups have no peers and it adds context.
 *   beautify        — plugin-backed document beautify tools should be enabled
 *                     only after the user explicitly opts in.
 *   workflow        — orchestration can create and run multi-step tasks, so a
 *                     new agent must opt in before the model receives it.
 */
export const DEFAULT_DISABLED_TOOL_NAMES = ["dm", "beautify", "workflow"];

export function uniqueToolNames(names: unknown): RuntimeToolName[] {
  const seen = new Set<string>();
  const result: RuntimeToolName[] = [];
  const input = Array.isArray(names) ? names : [];
  for (const name of input) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * Settings needs a stable per-agent tool configuration surface even when an
 * agent is only config-loaded and its runtime tools have not been initialized.
 * Runtime tool names are preserved for compatibility, while built-in optional
 * categories are exposed from the central whitelist. Plugin-backed optional
 * categories only appear when their plugin tools are actually registered.
 *
 * @param {string[]} runtimeToolNames
  *
 * @returns {string[]}
 */
export function computeSettingsAvailableToolNames(
  runtimeToolNames: unknown,
  options: SettingsAvailableToolOptions = {},
): RuntimeToolName[] {
  const result = new Set(uniqueToolNames(runtimeToolNames));
  const pluginTools = Array.isArray(options.pluginTools) ? options.pluginTools : [];
  for (const name of OPTIONAL_TOOL_NAMES) {
    const pluginId = PLUGIN_BACKED_OPTIONAL_TOOL_IDS[name];
    if (pluginId && !pluginTools.some((tool) => tool?._pluginId === pluginId)) continue;
    result.add(name);
  }
  return [...result];
}

/**
 * Startup-time invariant: every built-in tool the engine composes MUST be
 * explicitly categorized. Throwing here always means a developer added a tool
 * without categorizing it. The fix is always: open this file and categorize it.
 *
 * Caller passes already-filtered names (plugin tools excluded by caller).
 *
 * @param {string[]} actualToolNames
 * @throws {Error} if any tool is uncategorized
 */
export function assertAllToolsCategorized(actualToolNames: string[]): void {
  const categorized = new Set([
    ...CORE_TOOL_NAMES,
    ...STANDARD_TOOL_NAMES,
    ...GLOBAL_TOOL_NAMES,
    ...OPTIONAL_TOOL_NAMES,
  ]);
  const missing = actualToolNames.filter((n) => !categorized.has(n));
  if (missing.length > 0) {
    throw new Error(
      `Tools not categorized in shared/tool-categories.js: ${missing.join(", ")}.\n` +
      `Every built-in tool must be explicitly labeled as core / standard / optional. ` +
      `See the header of shared/tool-categories.js for the decision rules.`
    );
  }
}

/**
 * Compute the final tool name list for a newly created session.
 *
 * Rule: remove from allNames any name that is BOTH in the disabled list AND
 * in OPTIONAL_TOOL_NAMES. Core/standard tools are untouchable even if the
 * disabled list has been tampered with (runtime second-line defense).
 *
 * @param {string[]} allNames
 * @param {string[]} disabled
  *
 * @returns {string[]} filtered tool names, order preserved from allNames
 */
export function computeToolSnapshot(
  allNames: unknown,
  disabled: unknown,
  options: ToolSnapshotOptions = {},
): RuntimeToolName[] {
  const effectivelyDisabled = new Set(
    (Array.isArray(disabled) ? disabled : []).filter((n) => OPTIONAL_TOOL_NAMES_SET.has(n))
  );
  const extraDisabled = new Set(
    (options.extraDisabled || []).filter((n) => typeof n === "string" && n)
  );
  return uniqueToolNames(allNames)
    .filter((n) => !effectivelyDisabled.has(n) && !extraDisabled.has(n));
}
