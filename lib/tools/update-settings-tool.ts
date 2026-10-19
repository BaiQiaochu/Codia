// @ts-nocheck
/**
 * update-settings-tool.js -设置修改工具（渐进式披露- *
  * */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { getToolSessionPath } from "./tool-session.ts";
import themeRegistry from "../../desktop/src/shared/theme-registry.cjs";
import { parseModelRef } from "../../shared/model-ref.ts";
import {
  createSettingsToolResult,
  createSettingsUpdate,
  formatSettingsValue,
} from "./settings-update-result.ts";

/**
 * i18n key -本地化标-批量转换
 */
function i18nLabels(keyMap) {
  return Object.fromEntries(Object.entries(keyMap).map(([k, v]) => [k, t(v)]));
}

function tr(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

const THEME_I18N = Object.fromEntries(
  Object.entries(themeRegistry.THEMES).map(([id, theme]) => [id, theme.i18nName])
);
THEME_I18N[themeRegistry.AUTO_OPTION.id] = themeRegistry.AUTO_OPTION.i18nName;

const THINKING_I18N = {
  "auto": "settings.agent.thinkingLevels.auto",
  "off": "settings.agent.thinkingLevels.off",
  "low": "settings.agent.thinkingLevels.low",
  "medium": "settings.agent.thinkingLevels.medium",
  "high": "settings.agent.thinkingLevels.high",
  "xhigh": "settings.agent.thinkingLevels.xhigh",
};

const LOCALE_LABELS = {
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  en: "English",
};

const MCP_SETTINGS_ACTIONS = {
  "mcp.global.enabled": {
    type: "toggle",
    label: "MCP enabled",
    description: "Enable or disable MCP connectors globally.",
    searchTerms: ["mcp", "connector", "server", "global", "enable", "disable"],
  },
  "mcp.connector.add": {
    type: "text",
    label: "Add MCP connector",
    description: "Add a remote or local MCP connector. Use a JSON value with name, transport, url or command, authType, and optional secrets.",
    searchTerms: ["mcp", "connector", "server", "add", "install", "github", "remote"],
  },
  "mcp.connector.update": {
    type: "text",
    label: "Update MCP connector",
    description: "Update an MCP connector. Use a JSON value with connectorId and the fields to change.",
    searchTerms: ["mcp", "connector", "server", "update", "edit"],
  },
  "mcp.connector.remove": {
    type: "text",
    label: "Remove MCP connector",
    description: "Remove an MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "server", "remove", "delete"],
  },
  "mcp.connector.start": {
    type: "text",
    label: "Start MCP connector",
    description: "Start an MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "server", "start"],
  },
  "mcp.connector.stop": {
    type: "text",
    label: "Stop MCP connector",
    description: "Stop an MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "server", "stop"],
  },
  "mcp.connector.refresh_tools": {
    type: "text",
    label: "Refresh MCP tools",
    description: "Refresh the tool list for a running MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "tools", "refresh", "reload"],
  },
  "mcp.agent.connector.enable": {
    type: "toggle",
    label: "Enable MCP connector for this agent",
    description: "Enable or disable one MCP connector for the current agent. Use JSON with connectorId and enabled.",
    scope: "agent",
    searchTerms: ["mcp", "agent", "connector", "enable", "disable"],
  },
  "mcp.agent.tool.enable": {
    type: "toggle",
    label: "Enable MCP tool for this agent",
    description: "Enable or disable one MCP tool for the current agent. Use JSON with connectorId, toolName, and enabled.",
    scope: "agent",
    searchTerms: ["mcp", "agent", "tool", "enable", "disable"],
  },
};

/**
  * */
const COMPUTER_USE_EXPERIMENT_SETTING_KEY = "experiments.computer_use.enabled";
const SETTING_KEY_ALIASES = {
  "computer_use.enabled": COMPUTER_USE_EXPERIMENT_SETTING_KEY,
};

function resolveSettingsKey(key) {
  return SETTING_KEY_ALIASES[key] || key;
}

function requireAgentId(agent, key) {
  const agentId = agent?.id || null;
  if (!agentId) throw new Error(`${key} requires target agent`);
  return agentId;
}

const SETTINGS_REGISTRY = {
  sandbox: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.sandbox"); },
    get description() { return t("toolDef.updateSettings.sandboxDesc"); },
    searchTerms: ["security", "安全", "权限", "セキュリティ", "보안"],
    get: (engine, _agent) => String(engine.preferences.getSandbox()),
    apply: (engine, _agent, v) => engine.setSandbox(v),
  },
  sandbox_network: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.sandboxNetwork"); },
    get description() { return t("toolDef.updateSettings.sandboxNetworkDesc"); },
    searchTerms: ["security", "network", "internet", "鑱旂綉", "curl", "pip", "npm"],
    get: (engine, _agent) => String(engine.preferences.getSandboxNetwork()),
    apply: (engine, _agent, v) => engine.setSandboxNetwork(v),
  },
  file_backup: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.fileBackup"); },
    get description() { return t("toolDef.updateSettings.fileBackupDesc"); },
    searchTerms: ["backup", "备份", "バックアップ", "백업", "checkpoint"],
    get: (engine, _agent) => String(engine.preferences.getFileBackup().enabled),
    apply: (engine, _agent, v) => {
      const enabled = typeof v === "string" ? v === "true" : !!v;
      engine.setFileBackup({ enabled });
    },
  },
  locale: {
    type: "list",
    get label() { return t("toolDef.updateSettings.locale"); },
    options: ["zh-CN", "zh-TW", "ja", "ko", "en"],
    optionLabels: LOCALE_LABELS,
    searchTerms: ["language", "locale", "i18n"],
    get: (engine, _agent) => engine.preferences.getLocale() || "zh-CN",
    apply: (engine, _agent, v) => engine.setLocale(v),
  },
  timezone: {
    type: "text",
    get label() { return t("toolDef.updateSettings.timezone"); },
    get description() { return t("toolDef.updateSettings.timezoneDesc"); },
    get: (engine, _agent) => engine.preferences.getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    apply: (engine, _agent, v) => engine.setTimezone(v),
  },
  bridge_media_public_base_url: {
    type: "text",
    get label() { return t("toolDef.updateSettings.bridgeMediaPublicBaseUrl"); },
    get description() { return t("toolDef.updateSettings.bridgeMediaPublicBaseUrlDesc"); },
    searchTerms: ["bridge", "media", "public url", "file delivery", "tunnel", "ngrok", "cloudflare"],
    get: (engine, _agent) => engine.getBridgeMediaPublicBaseUrl?.() || "",
    apply: (engine, _agent, v) => engine.setBridgeMediaPublicBaseUrl(v),
  },
  [COMPUTER_USE_EXPERIMENT_SETTING_KEY]: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.computerUse"); },
    get description() { return t("toolDef.updateSettings.computerUseDesc"); },
    searchTerms: ["computer use", "computer", "电脑控制", "使用电脑", "实验", "desktop control", "gui"],
    get: (engine, _agent) => String(engine.getComputerUseSettings?.()?.enabled === true),
    apply: async (engine, _agent, v) => {
      const enabled = v === true || v === "true";
      if (typeof engine.updateComputerUseSettings === "function") {
        await engine.updateComputerUseSettings({ enabled });
        return;
      }
      if (typeof engine.setComputerUseSettings === "function") {
        engine.setComputerUseSettings({ enabled });
        return;
      }
      throw new Error("computer use preferences are not available");
    },
  },
  thinking_level: {
    type: "list",
    get label() { return t("toolDef.updateSettings.thinkingBudget"); },
    options: ["auto", "off", "low", "medium", "high", "xhigh"],
    get optionLabels() { return i18nLabels(THINKING_I18N); },
    searchTerms: ["reasoning", "thinking"],
    get: (engine, _agent) => engine.preferences.getThinkingLevel() || "auto",
    apply: (engine, _agent, v) => engine.setThinkingLevel(v),
  },
  "memory.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.memory"); },
    get description() { return t("toolDef.updateSettings.memoryDesc"); },
    scope: "agent",
    get: (engine, agent) => agent ? String(agent.memoryMasterEnabled !== false) : null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ memory: { enabled: v === true || v === "true" } });
    },
  },
  "memory.facts": {
    type: "text",
    get label() { return t("toolDef.updateSettings.memoryFacts"); },
    description: "Bulk compiled memory editing is retired. Correct individual sourced facts in Settings > Agent > Memory; use memory_search to inspect relevant facts.",
    scope: "agent",
    searchTerms: ["facts", "editable memory", "memory facts", "user facts"],
    get: (_engine, agent) => agent ? "Retired: manage individual sourced facts in the memory page." : null,
    apply: () => {
      throw new Error("Bulk memory.facts editing is retired. Correct individual sourced facts in the memory page so provenance, revisions and forgetting remain consistent.");
    },
  },
  "experience.enabled": {
    type: "toggle",
    get label() { return tr("toolDef.updateSettings.experience", "Experience Library"); },
    get description() { return tr("toolDef.updateSettings.experienceDesc", "Enable/disable experience recall and recording for current Agent"); },
    scope: "agent",
    searchTerms: ["experience", "经验", "成长", "経験", "경험"],
    get: (_engine, agent) => agent ? String(agent.experienceEnabled === true) : null,
    apply: (_engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ experience: { enabled: v === true || v === "true" } });
    },
  },
  "agent.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.agentName"); },
    scope: "agent",
    get: (engine, agent) => agent?.agentName || null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ agent: { name: v } });
    },
  },
  "user.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.userName"); },
    scope: "agent",
    get: (engine, agent) => agent?.userName || null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ user: { name: v } });
    },
  },
  home_folder: {
    type: "text",
    get label() { return t("toolDef.updateSettings.workingDir"); },
    get description() { return t("toolDef.updateSettings.workingDirDesc"); },
    scope: "agent",
    get: (engine, agent) => engine.getHomeFolder(requireAgentId(agent, "home_folder")) || "",
    apply: (engine, agent, v) => engine.setHomeFolder(requireAgentId(agent, "home_folder"), v),
  },
  theme: {
    type: "list",
    get label() { return t("toolDef.updateSettings.theme"); },
    options: [...themeRegistry.getThemeIds(), themeRegistry.AUTO_OPTION.id],
    get optionLabels() { return i18nLabels(THEME_I18N); },
    searchTerms: ["dark", "light", "暗色", "亮色", "外观", "appearance", "夜间", "dark mode"],
    frontend: true,
    get: (_engine, _agent) => "auto",
    apply: null,
  },
  "models.chat": {
    type: "list",
    get label() { return t("toolDef.updateSettings.chatModel"); },
    scope: "agent",
    optionsFrom: "availableModels",
    searchTerms: ["model", "chat"],
    get: (_engine, agent) => {
      const ref = parseModelRef(agent?.config?.models?.chat);
      if (!ref?.id) return null;
      return ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
    },
    apply: async (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      const ref = parseModelRef(v);
      if (!ref?.id || !ref?.provider) {
        throw new Error(`models.chat requires provider/id (got ${JSON.stringify(v)})`);
      }
      await engine.setDefaultModel(ref.id, ref.provider, { agentId: agent.id });
    },
  },
};

// ── 搜索 ──

function resolveOptions(reg, engine) {
  if (reg.optionsFrom === "availableModels") {
    return (engine.availableModels || []).map(m => `${m.provider}/${m.id}`);
  }
  return reg.options || null;
}

function resolveOptionLabels(reg, engine) {
  if (reg.optionsFrom === "availableModels") {
    return Object.fromEntries(
      (engine.availableModels || []).map(m => [`${m.provider}/${m.id}`, m.name || m.id]),
    );
  }
  return reg.optionLabels || null;
}

function resolveTargetAgent(engine, fallbackAgent) {
  const agentId = fallbackAgent?.id || null;
  if (!agentId) return { agentId: null, agent: fallbackAgent || null };
  const agent = typeof engine?.getAgent === "function"
    ? (engine.getAgent(agentId) || fallbackAgent)
    : fallbackAgent;
  return { agentId, agent };
}

function searchSettings(query, engine, _agent) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const [key, reg] of Object.entries({ ...SETTINGS_REGISTRY, ...MCP_SETTINGS_ACTIONS })) {
    const options = resolveOptions(reg, engine);
    const optionLabels = resolveOptionLabels(reg, engine);
    const haystack = [
      key, reg.label, reg.description || "",
      ...(reg.searchTerms || []),
      ...(options || []),
      ...Object.keys(optionLabels || {}),
      ...Object.values(optionLabels || {}),
    ].join(" ").toLowerCase();
    if (haystack.includes(q)) {
      results.push({ key, reg, options });
    }
  }
  return results;
}

//

function formatOptionList(options, labels, maxShow = 10) {
  if (!options?.length) return "";
  const shown = options.slice(0, maxShow);
  const rest = options.length - shown.length;
  const parts = shown.map(o => labels?.[o] ? `${o}(${labels[o]})` : o);
  if (rest > 0) parts.push(`...+${rest}`);
  return parts.join(" / ");
}

function formatSearchResults(results, engine, agent) {
  return results.map((r, i) => {
    const { key, reg, options } = r;
    const ol = resolveOptionLabels(reg, engine);
    const lines = [`[${i + 1}] ${key} - ${reg.label} (${reg.type})`];

 //
    if (reg.frontend) {
      lines.push(`    ${t("toolDef.updateSettings.frontendOnly")}`);
    } else if (typeof reg.get === "function") {
      const cv = reg.get(engine, agent);
      if (cv === null) {
        lines.push("    -> (N/A)");
      } else {
        const cvLabel = ol?.[cv] ? `${cv} (${ol[cv]})` : cv;
        lines.push(`    -> ${cvLabel}`);
      }
    } else if (reg.scope === "agent" && !agent) {
      lines.push("    -> (N/A)");
    }

 // 选项列表
    if (options?.length) {
      lines.push(`    ${formatOptionList(options, ol)}`);
    }
    if (reg.description) {
      lines.push(`    ${reg.description}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

// ── 工具 ──

function parseSettingsPayload(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return {};
  if (raw === "true" || raw === "false") return { enabled: raw === "true", value: raw === "true" };
  if (raw.startsWith("{") || raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  }
  return { value: raw };
}

async function applyMcpSettingsAction(engine, key, value, agentId) {
  const bus = engine?.getEventBus?.() || engine?.eventBus || null;
  if (!bus?.request) {
    return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
  }
  let payload;
  try {
    payload = parseSettingsPayload(value);
  } catch (err) {
    return { content: [{ type: "text", text: t("error.settingsApplyFailed", { msg: err.message }) }] };
  }
  try {
    const result = await bus.request("mcp:settings-action", { action: key, agentId: agentId || null, payload });
    if (result?.settingsUpdate) {
      return createSettingsToolResult(result.settingsUpdate, {
        settingKey: key,
        cardType: MCP_SETTINGS_ACTIONS[key]?.type || "text",
        confirmed: true,
      });
    }
    return createSettingsToolResult({
      status: "applied",
      action: key,
      key,
      title: "MCP settings updated",
      summary: "MCP settings were updated.",
    }, { settingKey: key, cardType: MCP_SETTINGS_ACTIONS[key]?.type || "text", confirmed: true });
  } catch (err) {
    const update = createSettingsUpdate({
      status: "failed",
      action: key,
      key,
      title: "MCP settings change failed",
      summary: err.message || "MCP settings change failed.",
    });
    return createSettingsToolResult(update, { settingKey: key, cardType: MCP_SETTINGS_ACTIONS[key]?.type || "text", confirmed: false });
  }
}

export function createUpdateSettingsTool(deps = {}) {
  const {
    getEngine,
    getAgent,
    getConfirmStore,
    getSessionPath: _getSessionPath,
    emitEvent,
  } = deps;

  return {
    name: "update_settings",
    userFacingName: t("toolDef.updateSettings.label"),
    description: t("toolDef.updateSettings.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["search", "apply"],
        { description: t("toolDef.updateSettings.actionDesc") },
      ),
      query: Type.Optional(Type.String({ description: t("toolDef.updateSettings.queryDesc") })),
      key: Type.Optional(Type.String({ description: t("toolDef.updateSettings.keyDesc") })),
      value: Type.Optional(Type.String({ description: t("toolDef.updateSettings.valueDesc") })),
    }),
    isUserFacing: true,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const engine = getEngine?.();
      const initialAgent = getAgent?.() || engine?.agent;
      const { agentId: targetAgentId, agent: targetAgent } = resolveTargetAgent(engine, initialAgent);

      switch (params.action) {
        // ── search ──
        case "search": {
          const query = params.query?.trim();
          if (!query) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchMissingQuery") }] };
          }
          if (!engine) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }
          const results = searchSettings(query, engine, targetAgent);
          if (results.length === 0) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchNoResults", { query }) }] };
          }
          const body = formatSearchResults(results, engine, targetAgent);
          return { content: [{ type: "text", text: t("toolDef.updateSettings.searchResult", { count: String(results.length), results: body }) }] };
        }

        // ── apply ──
        case "apply": {
          const { key, value } = params;
          if (!key || value === undefined) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.applyMissingParams") }] };
          }
          const canonicalKey = resolveSettingsKey(key);
          if (!engine) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }
          if (Object.hasOwn(MCP_SETTINGS_ACTIONS, canonicalKey)) {
            const actionMeta = MCP_SETTINGS_ACTIONS[canonicalKey];
            if (actionMeta.scope === "agent" && !targetAgentId) {
              return { content: [{ type: "text", text: t("error.settingsNoAgent") }] };
            }
            return applyMcpSettingsAction(engine, canonicalKey, value, targetAgentId);
          }
          const reg = SETTINGS_REGISTRY[canonicalKey];
          if (!reg) {
            return { content: [{ type: "text", text: t("error.settingsUnknownKey", { key }) }] };
          }

          const confirmStore = getConfirmStore?.();
          const sessionPath = getToolSessionPath(ctx);
          if (!confirmStore) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }

 // scope: "agent" 的设置在-agent 时拒绝操-
          if (reg.scope === "agent" && !targetAgent) {
            return { content: [{ type: "text", text: t("error.settingsNoAgent") }] };
          }

 //
          const currentValue = reg.get(engine, targetAgent);

 //
          const options = resolveOptions(reg, engine);

          // toggle 校验
          if (reg.type === "toggle" && value !== "true" && value !== "false") {
            return { content: [{ type: "text", text: t("error.settingsInvalidToggle") }] };
          }

          // list 校验
          if (reg.type === "list" && options?.length && !options.includes(value)) {
            const ol = resolveOptionLabels(reg, engine);
            const optList = formatOptionList(options, ol);
            return { content: [{ type: "text", text: t("error.settingsInvalidValue", { value, options: optList }) }] };
          }

 // 选项本地化标-
          const optionLabels = resolveOptionLabels(reg, engine);

 // 供所有返回路径携带的 block 描述
          const blockDetails = {
            settingKey: canonicalKey,
            cardType: reg.type,
            currentValue: String(currentValue ?? ""),
            proposedValue: String(value),
            label: reg.label || canonicalKey,
          };

 // 创建阻塞确认
          const { confirmId, promise } = confirmStore.create(
            "settings",
            { key: canonicalKey, label: reg.label, description: reg.description, type: reg.type, currentValue, proposedValue: value, options, optionLabels, frontend: reg.frontend },
            sessionPath,
          );

 // 广播确认事件
          emitEvent?.({
            type: "settings_confirmation",
            confirmId,
            settingKey: canonicalKey,
            cardType: reg.type,
            currentValue,
            proposedValue: value,
            options: options || null,
            optionLabels,
            label: reg.label,
            description: reg.description || null,
            frontend: !!reg.frontend,
            agentId: targetAgentId,
          }, sessionPath);

 // 阻塞等待用户确认
          const result = await promise;

          if (result.action === "confirmed") {
            const finalValue = result.value !== undefined ? String(result.value) : value;
            try {
              if (reg.frontend) {
                emitEvent?.({ type: "apply_frontend_setting", key: canonicalKey, value: finalValue }, sessionPath);
              } else {
                if (typeof reg.apply === "function") {
                  const parsed = reg.type === "toggle" ? (finalValue === "true") : finalValue;
                  const { agent: applyAgent } = resolveTargetAgent(engine, targetAgent);
                  await reg.apply(engine, applyAgent, parsed);
                }
              }
              const afterValue = reg.frontend
                ? finalValue
                : (typeof reg.get === "function" ? reg.get(engine, targetAgent) : finalValue);
              const label = reg.label || canonicalKey;
              return createSettingsToolResult({
                status: "applied",
                action: "core.apply",
                key: canonicalKey,
                title: `${label} updated`,
                summary: `${label} changed from ${formatSettingsValue(currentValue, { key: canonicalKey })} to ${formatSettingsValue(afterValue, { key: canonicalKey })}.`,
                target: reg.scope === "agent"
                  ? { type: "agent", id: targetAgentId, label: targetAgent?.agentName || targetAgentId }
                  : { type: "global", id: "preferences", label: "Preferences" },
                changes: [{
                  key: canonicalKey,
                  label,
                  before: currentValue,
                  after: afterValue,
                }],
              }, { ...blockDetails, confirmed: true });
            } catch (err) {
              return createSettingsToolResult({
                status: "failed",
                action: "core.apply",
                key: canonicalKey,
                title: `${reg.label || canonicalKey} update failed`,
                summary: err.message || t("error.settingsApplyFailed", { msg: "" }),
              }, { ...blockDetails, confirmed: false });
            }
          } else if (result.action === "rejected") {
            return { content: [{ type: "text", text: t("error.settingsCancelled", { label: reg.label }) }], details: { ...blockDetails, confirmed: false } };
          } else {
 //
            return { content: [{ type: "text", text: t("error.settingsTimeout", { label: reg.label }) }], details: { ...blockDetails, confirmed: "timeout" } };
          }
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
      }
    },
  };
}
