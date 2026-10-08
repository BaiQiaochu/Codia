/**
 * 全局偏好设置路由（跨 agent 共享）
 *
 * GET  /api/preferences/models  — 读取全局模型 + 搜索配置
 * PUT  /api/preferences/models  — 更新全局模型 + 搜索配置
 */

import { Hono } from "hono";
import { emitAppEvent } from "../app-events.ts";
import { routeError, strictJson } from "../hono-helpers.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { normalizeWorkspacePath } from "../../shared/workspace-history.ts";
import {
  SEARCH_API_PROVIDER_IDS,
  normalizeSearchApiKeys,
} from "../../shared/search-providers.ts";
import {
  normalizeWorkspaceUiEntry,
  normalizeWorkspaceUiSurface,
} from "../../shared/workspace-ui-state.ts";
import { normalizeSidebarUiPrefs, normalizeSidebarUiPrefsPatch } from "../../shared/sidebar-ui-state.ts";
import {
  normalizeSharedModelsPatch,
  sharedModelsPatchRequiresModelSync,
} from "../../core/config-coordinator.ts";
import { normalizeNotificationPreferences } from "../../shared/notification-preferences.ts";
import { normalizeQuickChatPreferences } from "../../shared/quick-chat-preferences.ts";
import { normalizeBrowserPreferences } from "../../shared/browser-preferences.ts";
import { modelSupportsImage } from "../../core/message-sanitizer.ts";
import crypto from "crypto";
import { normalizePublicBaseUrl } from "../../shared/net-utils.ts";
import {
  effectiveComputerUseSettings,
  isComputerUsePlatformSupported,
  selectedComputerProviderId,
} from "../../core/computer-use/platform-support.ts";
import { SESSION_PERMISSION_MODES } from "../../core/session-permission-mode.ts";
import { isMaskedSecretValue, maskSecretValue, resolveSecretPatch } from "../../shared/secret-custody.ts";
import { BrowserManager } from "../../lib/browser/browser-manager.ts";

function modelEntryId(model) {
  if (!model) return "";
  return typeof model === "object" ? model.id : model;
}

function findAvailableModel(engine, ref) {
  if (!ref?.id || !ref?.provider || !Array.isArray(engine.availableModels)) return null;
  return engine.availableModels.find((m) => m?.id === ref.id && m?.provider === ref.provider) || null;
}

function findRawProviderModel(engine, ref) {
  if (!ref?.id || !ref?.provider) return null;
  const rawProviders = engine.providerRegistry?.getAllProvidersRaw?.();
  const models = rawProviders?.[ref.provider]?.models;
  if (!Array.isArray(models)) return null;
  return models.find((m) => modelEntryId(m) === ref.id) || null;
}

function visionRefSupportsImage(engine, ref, resolved) {
  if (modelSupportsImage(resolved?.model)) return true;
  if (modelSupportsImage(findAvailableModel(engine, ref))) return true;
  const rawModel = findRawProviderModel(engine, ref);
  return typeof rawModel === "object" && modelSupportsImage(rawModel);
}

type SessionPermissionDefaultMode = typeof SESSION_PERMISSION_MODES[keyof typeof SESSION_PERMISSION_MODES];

const SESSION_PERMISSION_MODE_VALUES = new Set<string>(Object.values(SESSION_PERMISSION_MODES));

function isSessionPermissionDefaultMode(value: string): value is SessionPermissionDefaultMode {
  return SESSION_PERMISSION_MODE_VALUES.has(value);
}

function parseSessionPermissionDefaultMode(body: any): SessionPermissionDefaultMode {
  const raw = body?.permissionMode ?? body?.mode ?? body?.accessMode;
  if (typeof raw !== "string" || !isSessionPermissionDefaultMode(raw)) {
    throw new Error("permissionMode must be one of auto, operate, ask, read_only");
  }
  return raw;
}

export function selectedComputerProviderIdFromSettings(settings, platform = process.platform) {
  return selectedComputerProviderId(settings, { platform });
}

export function disabledComputerUseStatus(settings, { platform = process.platform } = {}) {
  return {
    enabled: false,
    platform,
    supported: isComputerUsePlatformSupported(platform),
    selectedProviderId: selectedComputerProviderIdFromSettings(settings, platform),
    providers: [],
    activeLease: null,
  };
}

export async function buildComputerUsePreferences(engine: any, { platform = process.platform } = {}) {
  const settings = effectiveComputerUseSettings(engine.getComputerUseSettings?.(), { platform });
  if (settings?.enabled !== true) {
    const status = disabledComputerUseStatus(settings, { platform });
    return {
      settings,
      status,
      selectedProviderId: status.selectedProviderId,
    };
  }
  const status = await engine.getComputerHost?.()?.getStatus?.({}) || null;
  return {
    settings,
    status,
    selectedProviderId: status?.selectedProviderId || selectedComputerProviderIdFromSettings(settings, platform),
  };
}

function maskSearchApiKeys(apiKeys) {
  const normalized = normalizeSearchApiKeys(apiKeys);
  return Object.fromEntries(
    Object.entries(normalized).map(([provider, key]) => [provider, maskSecretValue(key)]),
  );
}

function resolveSearchApiKeysPatch(patch, existing) {
  const saved = normalizeSearchApiKeys(existing);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return saved;
  const out = { ...saved };
  for (const provider of SEARCH_API_PROVIDER_IDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, provider)) continue;
    const value = patch[provider];
    if (isMaskedSecretValue(value)) {
      if (saved[provider]) out[provider] = saved[provider];
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      delete out[provider];
      continue;
    }
    out[provider] = value.trim();
  }
  return out;
}

function resolveSearchPreferencePatch(patch: any, existing: any) {
  const resolved: Record<string, any> = resolveSecretPatch({
    patch,
    existing,
    secretKeys: ["api_key"],
  });
  if (patch?.api_keys !== undefined) {
    resolved.api_keys = resolveSearchApiKeysPatch(patch.api_keys, existing?.api_keys || {});
  }
  return resolved;
}

function pluginUiPrefsPatchFromBody(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const patch: Record<string, any> = {};
  const aliases = [
    ["tabOrder", "pluginTabOrder"],
    ["pinnedWidgets", "pluginPinnedWidgets"],
    ["hiddenTabs", "pluginHiddenTabs"],
    ["hiddenWidgets", "pluginHiddenWidgets"],
  ];
  for (const [canonical, legacy] of aliases) {
    if (Array.isArray(body[canonical])) patch[canonical] = body[canonical];
    else if (Array.isArray(body[legacy])) patch[canonical] = body[legacy];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function browserManagerFromOptions(options: Record<string, any>) {
  return options.browserManager || BrowserManager.instance();
}

export function createPreferencesRoute(engine: any, options: Record<string, any> = {}) {
  const { platform = process.platform } = options;
  const route = new Hono<any>();

  // 读取全局模型 + 搜索配置
  route.get("/preferences/models", async (c) => {
    try {
      const models = engine.getSharedModels();
      const search = engine.getSearchConfig();
      const utilityApi = engine.getUtilityApi();

      return c.json({
        models,
        search: {
          provider: search.provider || "",
          api_key: maskSecretValue(search.api_key || ""),
          api_keys: maskSearchApiKeys(search.api_keys || {}),
        },
        utility_api: {
          provider: utilityApi.provider || "",
          base_url: utilityApi.base_url || "",
          api_key: maskSecretValue(utilityApi.api_key || ""),
        },
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 更新全局模型 + 搜索配置
  route.put("/preferences/models", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }

      const sections = [];
      let needsModelSync = false;
      // 共享模型（utility / utility_large）
      if (body.models) {
        let modelsPatch;
        try {
          modelsPatch = normalizeSharedModelsPatch(body.models);
        } catch (err) {
          return c.json({ error: err.message }, 400);
        }
        if (modelsPatch.vision) {
          let resolved;
          try {
            resolved = engine.resolveModelWithCredentials(modelsPatch.vision);
          } catch (err) {
            return c.json({ error: err.message }, 400);
          }
          if (!visionRefSupportsImage(engine, modelsPatch.vision, resolved)) {
            return c.json({ error: "vision model must support image input" }, 400);
          }
        }
        engine.setSharedModels(modelsPatch);
        sections.push("models");
        needsModelSync = sharedModelsPatchRequiresModelSync(modelsPatch);
      }

      // 搜索配置
      if (body.search) {
        engine.setSearchConfig(resolveSearchPreferencePatch(body.search, engine.getSearchConfig?.() || {}));
        sections.push("search");
      }

      // utility API 配置
      if (body.utility_api) {
        engine.setUtilityApi(resolveSecretPatch({
          patch: body.utility_api,
          existing: engine.getUtilityApi?.() || {},
          secretKeys: ["api_key"],
        }));
        sections.push("utility_api");
      }

      if (needsModelSync) {
        try { await engine.syncModelsAndRefresh(); } catch (e) {
          debugLog()?.warn("api", `syncModelsAndRefresh after preferences change: ${e.message}`);
        }
      }

      debugLog()?.log("api", `PUT /api/preferences/models sections=[${sections.join(",")}]`);
      if (sections.length > 0) {
        emitAppEvent(engine, "models-changed", { agentId: engine.currentAgentId || null });
      }
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/preferences/models failed: ${err.message}`);
      return routeError(c, err);
    }
  });

  route.get("/preferences/appearance", async (c) => {
    try {
      return c.json({ appearance: engine.getAppearance?.() || {} });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/appearance", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const patch = body.appearance && typeof body.appearance === "object" ? body.appearance : body;
      const before = engine.getAppearance?.() || {};
      const appearance = engine.setAppearance?.(patch) || {};
      emitAppearanceEvents(engine, before, appearance);
      return c.json({ ok: true, appearance });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.get("/preferences/session-permission-default", async (c) => {
    try {
      return c.json({ permissionMode: engine.getSessionPermissionModeDefault?.() || SESSION_PERMISSION_MODES.ASK });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/session-permission-default", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof engine.setSessionPermissionModeDefault !== "function") {
        return c.json({ error: "session permission default preferences unavailable" }, 500);
      }
      let permissionMode;
      try {
        permissionMode = parseSessionPermissionDefaultMode(body);
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }
      const saved = engine.setSessionPermissionModeDefault(permissionMode);
      return c.json({ ok: true, permissionMode: saved });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.get("/preferences/quick-chat", async (c) => {
    try {
      return c.json({ quickChat: engine.getQuickChatPreferences?.() || normalizeQuickChatPreferences({}) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/quick-chat", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof engine.setQuickChatPreferences !== "function") {
        return c.json({ error: "quick chat preferences unavailable" }, 500);
      }
      const patch = body.quickChat && typeof body.quickChat === "object" ? body.quickChat : body;
      const quickChat = engine.setQuickChatPreferences(patch);
      return c.json({ ok: true, quickChat });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.get("/preferences/browser", async (c) => {
    try {
      return c.json({
        browser: engine.getBrowserPreferences?.() || normalizeBrowserPreferences({}),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/browser", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof engine.setBrowserPreferences !== "function") {
        return c.json({ error: "browser preferences unavailable" }, 500);
      }
      const patch = body.browser && typeof body.browser === "object" ? body.browser : body;
      const browser = engine.setBrowserPreferences(patch);
      const applyBrowserPreferences = options.applyBrowserPreferences
        || ((settings: any) => browserManagerFromOptions(options).setBrowserPreferences(settings));
      await applyBrowserPreferences(browser);
      return c.json({ ok: true, browser });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.post("/preferences/browser/clear-cookies", async (c) => {
    try {
      const clearBrowserCookiesAndSiteData = options.clearBrowserCookiesAndSiteData
        || (() => browserManagerFromOptions(options).clearBrowserCookiesAndSiteData());
      await clearBrowserCookiesAndSiteData();
      return c.json({ ok: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.get("/preferences/notifications", async (c) => {
    try {
      return c.json({ notifications: engine.getNotificationPreferences?.() || normalizeNotificationPreferences({}) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/notifications", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof engine.setNotificationPreferences !== "function") {
        return c.json({ error: "notification preferences unavailable" }, 500);
      }
      const patch = body.notifications && typeof body.notifications === "object" ? body.notifications : body;
      const notifications = engine.setNotificationPreferences(patch);
      return c.json({ ok: true, notifications });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.get("/preferences/workspace-ui-state", async (c) => {
    try {
      const workspace = normalizeWorkspacePath(c.req.query("workspace"));
      if (!workspace) return c.json({ error: "workspace must be a non-empty path" }, 400);
      const surface = normalizeWorkspaceUiSurface(c.req.query("surface"));
      if (!surface) return c.json({ error: "workspace UI surface is invalid" }, 400);
      if (typeof engine.getWorkspaceUiState !== "function") {
        return c.json({ error: "workspace UI state unavailable" }, 500);
      }
      return c.json({ state: engine.getWorkspaceUiState(workspace, surface) });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.put("/preferences/workspace-ui-state", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const workspace = normalizeWorkspacePath(body.workspace);
      if (!workspace) return c.json({ error: "workspace must be a non-empty path" }, 400);
      const surface = normalizeWorkspaceUiSurface(body.surface);
      if (!surface) return c.json({ error: "workspace UI surface is invalid" }, 400);
      if (typeof engine.setWorkspaceUiState !== "function") {
        return c.json({ error: "workspace UI state unavailable" }, 500);
      }
      const state = engine.setWorkspaceUiState(workspace, surface, normalizeWorkspaceUiEntry(body.state || {}));
      return c.json({ ok: true, state });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.get("/preferences/sidebar-ui", async (c) => {
    try {
      return c.json({ sidebarUi: engine.getSidebarUiPrefs?.() || normalizeSidebarUiPrefs({}) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/sidebar-ui", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof engine.setSidebarUiPrefs !== "function") {
        return c.json({ error: "sidebar UI preferences unavailable" }, 500);
      }
      const sidebarUi = engine.setSidebarUiPrefs(normalizeSidebarUiPrefsPatch(body.sidebarUi || body));
      return c.json({ ok: true, sidebarUi });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.get("/preferences/plugin-ui", async (c) => {
    try {
      if (typeof engine.getPluginUiPrefs !== "function") {
        return c.json({ tabOrder: [], pinnedWidgets: [], hiddenTabs: [], hiddenWidgets: [] });
      }
      return c.json(engine.getPluginUiPrefs());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/plugin-ui", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (typeof engine.setPluginUiPrefs !== "function") {
        return c.json({ error: "plugin UI preferences unavailable" }, 500);
      }
      const result = engine.setPluginUiPrefs(body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.get("/preferences", async (c) => {
    try {
      return c.json({
        pluginUi: typeof engine.getPluginUiPrefs === "function"
          ? engine.getPluginUiPrefs()
          : { tabOrder: [], pinnedWidgets: [], hiddenTabs: [], hiddenWidgets: [] },
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const pluginUiPatch = pluginUiPrefsPatchFromBody(body);
      if (!pluginUiPatch) return c.json({ ok: true });
      if (typeof engine.setPluginUiPrefs !== "function") {
        return c.json({ error: "plugin UI preferences unavailable" }, 500);
      }
      const pluginUi = engine.setPluginUiPrefs(pluginUiPatch);
      return c.json({ ok: true, pluginUi });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  route.post("/preferences/setup-complete", async (c) => {
    try {
      const body = c.req.header("content-type")?.includes("application/json") ? await strictJson(c) : {};
      const mode = body.mode || "ai";
      if (!["ai", "files-only"].includes(mode)) return c.json({ error: "invalid_setup_mode" }, 400);
      const result = typeof engine.markSetupComplete === "function"
        ? engine.markSetupComplete(mode)
        : engine.preferences?.markSetupComplete?.(mode);
      if (result?.setupComplete !== true) {
        throw new Error("setup completion manager is unavailable");
      }
      return c.json({ ok: true, setupComplete: true, setupMode: result.setupMode || mode });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/preferences/web-access", async (c) => {
    try {
      return c.json(engine.preferences.getWebAccess());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/preferences/web-access", async (c) => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }

      const current = engine.preferences.getWebAccess();
      const hasPublicBaseUrl = Object.prototype.hasOwnProperty.call(body, "public_base_url");
      const rawPublicBaseUrl = hasPublicBaseUrl ? String(body.public_base_url || "").trim() : "";
      const nextPublicBaseUrl = hasPublicBaseUrl
        ? normalizePublicBaseUrl(rawPublicBaseUrl)
        : current.public_base_url;

      if (rawPublicBaseUrl && !nextPublicBaseUrl) {
        return c.json({ error: "public_base_url must be an http(s) URL" }, 400);
      }

      engine.preferences.setWebAccess({
        api_key: current.api_key,
        created_at: current.created_at || undefined,
        enabled: current.enabled,
        external_enabled: Object.prototype.hasOwnProperty.call(body, "external_enabled")
          ? !!body.external_enabled
          : current.external_enabled,
        public_base_url: nextPublicBaseUrl,
      });

      return c.json(engine.preferences.getWebAccess());
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/preferences/web-access/generate", async (c) => {
    try {
      const apiKey = `gsap_${crypto.randomBytes(32).toString("base64url")}`;
      const createdAt = new Date().toISOString();
      const current = engine.preferences.getWebAccess();
      engine.preferences.setWebAccess({
        api_key: apiKey,
        created_at: createdAt,
        enabled: true,
        external_enabled: current.external_enabled,
        public_base_url: current.public_base_url,
      });
      return c.json(engine.preferences.getWebAccess());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/preferences/web-access", async (c) => {
    try {
      engine.preferences.clearWebAccess();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/preferences/computer-use", async (c) => {
    try {
      return c.json(await buildComputerUsePreferences(engine, { platform }));
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.put("/preferences/computer-use", async (c) => {
    try {
      if (!isComputerUsePlatformSupported(platform)) {
        return c.json({ error: "Computer Use is not supported on Linux Preview." }, 400);
      }
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const nextSettings = body.settings && typeof body.settings === "object" ? body.settings : body;
      const settings = typeof engine.updateComputerUseSettings === "function"
        ? await engine.updateComputerUseSettings(nextSettings)
        : engine.setComputerUseSettings(nextSettings);
      debugLog()?.log("api", "PUT /api/preferences/computer-use");
      emitAppEvent(engine, "computer-use-settings-changed", {
        selectedProviderId: selectedComputerProviderIdFromSettings(settings, platform),
      });
      return c.json({ ok: true, settings });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/preferences/computer-use/request-permissions", async (c) => {
    try {
      if (!isComputerUsePlatformSupported(platform)) {
        return c.json({ error: "Computer Use is not supported on Linux Preview." }, 400);
      }
      const body = await strictJson(c).catch(() => ({}));
      const providerId = body && typeof body === "object" ? body.providerId || null : null;
      const result = await engine.getComputerHost?.()?.requestPermissions?.({}, providerId);
      emitAppEvent(engine, "computer-use-permissions-requested", {
        providerId: providerId || result?.providerId || null,
      });
      return c.json({ ok: true, result });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/preferences/computer-use/approvals", async (c) => {
    try {
      if (!isComputerUsePlatformSupported(platform)) {
        return c.json({ error: "Computer Use is not supported on Linux Preview." }, 400);
      }
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const settings = engine.approveComputerUseApp(body);
      emitAppEvent(engine, "computer-use-settings-changed", {
        providerId: body.providerId || null,
        appId: body.appId || null,
      });
      return c.json({ ok: true, settings });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.delete("/preferences/computer-use/approvals", async (c) => {
    try {
      if (!isComputerUsePlatformSupported(platform)) {
        return c.json({ error: "Computer Use is not supported on Linux Preview." }, 400);
      }
      const body = await strictJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const settings = engine.revokeComputerUseApp(body);
      emitAppEvent(engine, "computer-use-settings-changed", {
        providerId: body.providerId || null,
        appId: body.appId || null,
      });
      return c.json({ ok: true, settings });
    } catch (err) {
      return routeError(c, err);
    }
  });

  return route;
}

function emitAppearanceEvents(engine, before, appearance) {
  if (appearance.theme && appearance.theme !== before.theme) {
    emitAppEvent(engine, "theme-changed", { theme: appearance.theme });
  }
  if (typeof appearance.paperTexture === "boolean" && appearance.paperTexture !== before.paperTexture) {
    emitAppEvent(engine, "paper-texture-changed", { enabled: appearance.paperTexture });
  }
  if (typeof appearance.leavesOverlay === "boolean" && appearance.leavesOverlay !== before.leavesOverlay) {
    emitAppEvent(engine, "leaves-overlay-changed", { enabled: appearance.leavesOverlay });
  }
}
