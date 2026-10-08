// @ts-nocheck
/**
 * 配置管理 REST 路由
 */
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { emitAppEvent } from "../app-events.ts";
import { safeJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { getRawConfig, clearConfigCache } from "../../lib/memory/config-loader.ts";
import { FactStore } from "../../lib/memory/fact-store.ts";
import {
  writeCompiledResetMarker,
  clearCompiledMemoryArtifacts,
  clearCompiledSummarySources,
} from "../../lib/memory/compiled-memory-state.ts";
import {
  buildCompiledMemoryMarkdown,
  readCompiledMemorySections,
  writeEditableFactsSection,
} from "../../lib/memory/compile.ts";
import {
  ensureDefaultWorkspace,
  resolveDefaultWorkspacePath,
} from "../../shared/default-workspace.ts";
import { splitByScope, injectGlobalFields } from '../../shared/config-scope.ts';
import {
  clearWorkspaceHistory,
  mergeWorkspaceHistory,
  normalizeWorkspacePath,
  removeWorkspaceHistoryEntries,
} from "../../shared/workspace-history.ts";
import { pruneMissingWorkspaceConfig } from "../../shared/workspace-persistence-gc.ts";
import {
  assertValidProviderCredentialPatch,
  collectProviderHeaderSecretPatchPathsFromConfig,
  maskProviderHeaders,
  resolveProviderHeadersPatch,
} from "../../shared/provider-auth.ts";
import { isSearchApiProvider, normalizeSearchApiKeys } from "../../shared/search-providers.ts";
import { collectSecretPatchPaths, isMaskedSecretValue, maskObjectSecrets, maskSecretValue, resolveSecretPatch } from "../../shared/secret-custody.ts";
import { resolveAgent, resolveAgentStrict, AgentNotFoundError } from "../utils/resolve-agent.ts";
import { readAgentEditablePrompt, refreshEditablePromptsForConfigChange, writeAgentEditablePrompt } from "../utils/agent-template.ts";
import { formatSkillsForPrompt } from "../../lib/pi-sdk/index.ts";
import {
  buildInlineProviderCredentialUpdate,
  clearInlineProviderCredentialFields,
  hasInlineProviderCredentialPatch,
} from "./provider-credentials.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import {
  EDITABLE_MEMORY_EXPERIMENT_ID,
  getResolvedExperimentValue,
} from "../../lib/experiments/registry.ts";

function hasOwn(value: any, key: any) {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function isEditableMemoryEnabled(engine: any) {
  try {
    return getResolvedExperimentValue(engine.preferences, EDITABLE_MEMORY_EXPERIMENT_ID) === true;
  } catch {
    return false;
  }
}

function hasModelMutationPayload(partial: any) {
  return hasOwn(partial, "providers")
    || hasOwn(partial, "models")
    || hasOwn(partial, "api")
    || hasOwn(partial, "embedding_api")
    || hasOwn(partial, "utility_api");
}

function hasProviderMutationPatch(partial: any) {
  if (!partial || typeof partial !== "object") return false;
  if (hasOwn(partial, "providers")) return true;
  return ["api", "embedding_api", "utility_api"].some((key) => hasInlineProviderCredentialPatch(partial[key]));
}

function assertValidProviderConfigCredentials(partial: any) {
  if (!partial || typeof partial !== "object") return;
  if (partial.providers && typeof partial.providers === "object") {
    for (const [providerId, patch] of Object.entries(partial.providers)) {
      if (patch === null) continue;
      assertValidProviderCredentialPatch(patch, `providers.${providerId}`, { allowMasked: true });
    }
  }
  for (const blockName of ["api", "embedding_api", "utility_api"]) {
    const block = partial[blockName];
    if (!block || typeof block !== "object") continue;
    assertValidProviderCredentialPatch(block, blockName, { allowMasked: true });
  }
}

function getGlobalValue(globalFields: any[], key: any) {
  return globalFields.find((field) => field.key === key)?.value;
}

function applyGlobalConfigFields(engine: any, globalFields: any[]) {
  for (const { key, setter, value } of globalFields) {
    const apply = engine?.[setter];
    if (typeof apply !== "function") {
      throw new Error(`Global config field "${key}" cannot be saved: engine.${setter} is unavailable`);
    }
    apply.call(engine, value);
  }
}

function emitConfigAppEvents(engine: any, { globalFields, agentPartial, providersChanged }: any) {
  const agentId = engine.currentAgentId || null;
  if (
    providersChanged
    || hasOwn(agentPartial, "api")
    || hasOwn(agentPartial, "embedding_api")
    || hasOwn(agentPartial, "utility_api")
    || hasOwn(agentPartial, "models")
  ) {
    emitAppEvent(engine, "models-changed", { agentId });
  }

  const locale = getGlobalValue(globalFields, "locale");
  if (locale !== undefined) {
    emitAppEvent(engine, "locale-changed", { locale });
  }

  const editor = getGlobalValue(globalFields, "editor");
  if (editor !== undefined) {
    emitAppEvent(engine, "editor-typography-changed", {
      editor: typeof engine.getEditor === "function" ? engine.getEditor() : editor,
    });
  }

  const chat = getGlobalValue(globalFields, "chat");
  if (chat !== undefined) {
    emitAppEvent(engine, "chat-layout-changed", {
      chat: typeof engine.getChat === "function" ? engine.getChat() : chat,
    });
  }

  const networkProxy = getGlobalValue(globalFields, "network_proxy");
  if (networkProxy !== undefined) {
    emitAppEvent(engine, "network-proxy-changed", {
      network_proxy: typeof engine.getNetworkProxy === "function" ? engine.getNetworkProxy() : networkProxy,
    });
  }
}

function latestIso(values: any[]) {
  let latest = null;
  let latestTime = -Infinity;
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const time = Date.parse(value);
    if (Number.isNaN(time)) continue;
    if (time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function normalizeMemoryStepHealth(step: any) {
  const failCount = Number(step?.failCount);
  return {
    lastSuccessAt: typeof step?.lastSuccessAt === "string" ? step.lastSuccessAt : null,
    lastErrorAt: typeof step?.lastErrorAt === "string" ? step.lastErrorAt : null,
    lastErrorMsg: step?.lastErrorMsg ? String(step.lastErrorMsg) : null,
    failCount: Number.isFinite(failCount) && failCount > 0 ? failCount : 0,
  };
}

function buildMemoryHealth(agent: any) {
  const base = {
    enabled: agent.memoryMasterEnabled !== false,
    reason: null,
    steps: {},
    failedSteps: [],
    maxFailCount: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
  };

  if (agent.memoryMasterEnabled === false) {
    return {
      ...base,
      status: "disabled",
      reason: "memory_disabled",
      enabled: false,
    };
  }

  if (!agent.memoryTicker || typeof agent.memoryTicker.getHealthStatus !== "function") {
    return {
      ...base,
      status: "unavailable",
      reason: "memory_ticker_unavailable",
    };
  }

  const steps: Record<string, any> = {};
  for (const [key, value] of Object.entries(agent.memoryTicker.getHealthStatus() || {})) {
    steps[key] = normalizeMemoryStepHealth(value);
  }

  const stepEntries = Object.entries(steps);
  const failedSteps = stepEntries
    .filter(([, step]) => step.failCount > 0 || !!step.lastErrorMsg || !!step.lastErrorAt)
    .map(([key]) => key);
  const maxFailCount = stepEntries.reduce((max, [, step]) => Math.max(max, step.failCount), 0);

  return {
    ...base,
    status: failedSteps.length === 0 ? "healthy" : (maxFailCount >= 3 ? "unhealthy" : "degraded"),
    steps,
    failedSteps,
    maxFailCount,
    lastSuccessAt: latestIso(stepEntries.map(([, step]) => step.lastSuccessAt)),
    lastErrorAt: latestIso(stepEntries.map(([, step]) => step.lastErrorAt)),
  };
}

export function createConfigRoute(engine: any) {
  const route = new Hono<any>();

  // 读取配置（脱敏：隐藏 API key，附带 _raw 原始结构 + providers）
  route.get("/config", async (c) => {
    try {
      await gcConfigWorkspacePersistence(engine);
      const config = { ...engine.config };
      const raw = getRawConfig(engine.configPath) || {};

      // 本地应用，直接返回完整 key（前端用 type="password" 控制显隐）

      // 附带原始配置结构（未经 fallback 解析，让前端知道用户显式设了什么）
      config._raw = {
        api: { provider: raw.api?.provider || "", base_url: raw.api?.base_url || "" },
        embedding_api: { provider: raw.embedding_api?.provider || "", base_url: raw.embedding_api?.base_url || "" },
        utility_api: { provider: raw.utility_api?.provider || "", base_url: raw.utility_api?.base_url || "" },
      };

      // 供应商列表（附带 model_count）
      const rawProviders = engine.providerRegistry.getAllProvidersRaw() as Record<string, any>;
      const providerEntries: Record<string, any> = {};
      for (const [name, p] of Object.entries(rawProviders)) {
        const entry = engine.providerRegistry.get(name);
        providerEntries[name] = {
          base_url: p.base_url || entry?.baseUrl || "",
          api: p.api || entry?.api || "",
          api_key: maskSecretValue(p.api_key || ""),
          headers: maskProviderHeaders(p.headers || {}),
          auth_type: p.auth_type || entry?.authType || "api-key",
          models: p.models || [],
          model_count: (p.models || []).length,
        };
      }
      config.providers = providerEntries;

      // 自动注入全局字段（schema-driven）
      injectGlobalFields(config, engine);
      config.setupMode = engine.preferences?.getSetupMode?.() || "ai";
      // cwd_history 过滤（agent-scope，但需要 existsSync 验证）
      return c.json(maskObjectSecrets(config));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/config/workspaces/recent", async (c) => {
    try {
      const body = await safeJson(c).catch(() => ({}));
      const folder = normalizeWorkspacePath(body?.path);
      if (!folder) return c.json({ error: "path must be a non-empty string" }, 400);
      const cwdHistory = removeWorkspaceHistoryEntries(engine.config.cwd_history, [folder]);
      await engine.updateConfig({ cwd_history: cwdHistory });
      return c.json({ ok: true, cwd_history: cwdHistory });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/config/workspaces/recent/all", async (c) => {
    try {
      const cwdHistory = clearWorkspaceHistory();
      await engine.updateConfig({ cwd_history: cwdHistory });
      return c.json({ ok: true, cwd_history: cwdHistory });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 更新配置
  route.post("/config/workspaces/recent", async (c) => {
    try {
      const body = await safeJson(c);
      const folder = normalizeWorkspacePath(body?.path);
      if (!folder) return c.json({ error: "path must be a non-empty string" }, 400);
      const stat = await fs.stat(folder).catch(() => null);
      if (!stat?.isDirectory()) return c.json({ error: "path must be an existing directory" }, 400);
      const cwdHistory = mergeWorkspaceHistory(engine.config.cwd_history, [folder]);
      await engine.updateConfig({ cwd_history: cwdHistory });
      return c.json({ ok: true, cwd_history: cwdHistory });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/config/default-workspace", async (c) => {
    return c.json({ path: resolveDefaultWorkspacePath() });
  });

  route.post("/config/default-workspace", async (c) => {
    try {
      return c.json({ ok: true, path: ensureDefaultWorkspace() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/config", async (c) => {
    try {
      const partial = await safeJson(c);
      if (!partial || typeof partial !== "object") {
        return c.json({ error: t("error.invalidJson") }, 400);
      }
      if (c.get("pwaSession") && hasModelMutationPayload(partial)) {
        return c.json({ error: "pwa_model_locked" }, 403);
      }
      const settingsDenied = denyWithoutScope(c, "settings.write");
      if (settingsDenied) return settingsDenied;
      if (hasProviderMutationPatch(partial)) {
        const providerDenied = denyWithoutScope(c, "providers.manage");
        if (providerDenied) return providerDenied;
      }
      const secretFields = [
        ...collectSecretPatchPaths(partial, ["api_key"] as any),
        ...collectProviderHeaderSecretPatchPathsFromConfig(partial),
      ];
      const secretDenied = denySecretMutationWithoutScope(c, secretFields);
      if (secretDenied) return secretDenied;
      assertValidProviderConfigCredentials(partial);
      // ── schema-driven 全局字段分流 ──
      const { global: globalFields, agent: agentPartial } = splitByScope(partial);
      applyGlobalConfigFields(engine, globalFields);

      // providers 块 → 全局 added-models.yaml
      let providersChanged = false;
      if (agentPartial.providers) {
        for (const [name, data] of Object.entries(agentPartial.providers) as Array<[string, any]>) {
          if (data === null) {
            engine.providerRegistry.removeProvider(name);
          } else {
            const rawProviders: Record<string, any> = engine.providerRegistry.getAllProvidersRaw?.() || {};
            const resolvedPatch = resolveSecretPatch({
              patch: data,
              existing: rawProviders[name] || {},
              secretKeys: ["api_key"],
            });
            if (hasOwn(data, "headers")) {
              resolvedPatch.headers = resolveProviderHeadersPatch({
                patch: data.headers,
                existing: rawProviders[name]?.headers || {},
              });
            }
            engine.providerRegistry.saveProvider(name, resolvedPatch);
          }
        }
        delete agentPartial.providers;
        providersChanged = true;
      }

      // 内联 API 凭证 → 全局 added-models.yaml 对应条目
      const rawConfig = getRawConfig(engine.configPath) || {};
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = agentPartial[blockName];
        if (hasInlineProviderCredentialPatch(block)) {
          const { provider: provName, update: provUpdate } = buildInlineProviderCredentialUpdate(
            block,
            rawConfig?.[blockName]?.provider || "",
            (provider) => engine.providerRegistry?.getAllProvidersRaw?.()?.[provider] || {},
          );
          if (!provName) {
            return c.json({ error: `${blockName}.provider is required when saving credentials` }, 400);
          }
          engine.providerRegistry.saveProvider(provName, provUpdate);
          clearInlineProviderCredentialFields(block);
          providersChanged = true;
        }
      }

      // providers 变更后确保运行时刷新
      if (providersChanged) {
        await engine.onProviderChanged();
        debugLog()?.log("api", `onProviderChanged OK after provider change (${engine.availableModels?.length ?? 0} models)`);
      }

      if (providersChanged && Object.keys(agentPartial).length === 0) {
        clearConfigCache();
        await engine.updateConfig({});
        emitConfigAppEvents(engine, { globalFields, agentPartial, providersChanged });
        recordSecurityAuditEvent(c, engine, {
          action: "settings.config.update",
          target: "config",
          secretFields,
        } as any);
        return c.json({ ok: true });
      }

      if (Object.keys(agentPartial).length === 0) {
        emitConfigAppEvents(engine, { globalFields, agentPartial, providersChanged });
        recordSecurityAuditEvent(c, engine, {
          action: "settings.config.update",
          target: "config",
          secretFields,
        } as any);
        return c.json({ ok: true });
      }
      debugLog()?.log("api", `PUT /api/config keys=[${Object.keys(agentPartial).join(",")}]`);
      if (providersChanged) clearConfigCache();
      await refreshEditablePromptsForConfigChange(engine, engine.currentAgentId, agentPartial);
      await engine.updateConfig(agentPartial);
      emitConfigAppEvents(engine, { globalFields, agentPartial, providersChanged });
      recordSecurityAuditEvent(c, engine, {
        action: "settings.config.update",
        target: "config",
        secretFields,
      } as any);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/config failed: ${err.message}`);
      if (err?.code === "invalid_provider_credential_value") {
        return c.json({ error: err.message, code: err.code, field: err.field }, 400);
      }
      return c.json({ error: err.message }, err.statusCode || 500);
    }
  });

  // ── System Prompt（只读，供 DevTools 查看）──
  // 注意：agent.systemPrompt 不含 skills 块（#399 修复后由 SDK 内部统一注入），
  // 这里手动拼接以保持开发者视图与 SDK 实际发送给 LLM 的 prompt 一致。

  route.get("/system-prompt", async (c) => {
    try {
      const agent = resolveAgent(engine, c);
      let content = agent.systemPrompt || "";
      const enabledSkills = agent.enabledSkills || [];
      if (enabledSkills.length > 0) {
        content += formatSkillsForPrompt(enabledSkills);
      }
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 人格文件（ishiki.md）──

  // 读取 ishiki.md 内容
  route.get("/ishiki", async (c) => {
    try {
      const content = await readAgentEditablePrompt(engine, resolveAgent(engine, c), "ishiki");
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 ishiki.md 内容，并触发 system prompt 重建
  route.put("/ishiki", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      const agent = resolveAgentStrict(engine, c);
      await writeAgentEditablePrompt(engine, agent, "ishiki", content);
      debugLog()?.log("api", `PUT /api/ishiki (saved, ${content.length} chars)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 ishiki.md）
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      debugLog()?.error("api", `PUT /api/ishiki failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 身份简介（identity.md）──

  route.get("/identity", async (c) => {
    try {
      const content = await readAgentEditablePrompt(engine, resolveAgent(engine, c), "identity");
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/identity", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      const agent = resolveAgentStrict(engine, c);
      await writeAgentEditablePrompt(engine, agent, "identity", content);
      debugLog()?.log("api", `PUT /api/identity (saved, ${content.length} chars)`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      debugLog()?.error("api", `PUT /api/identity failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 用户档案（user.md）──

  // 读取 user.md 内容
  route.get("/user-profile", async (c) => {
    try {
      const userPath = path.join(engine.userDir, "user.md");
      const content = await fs.readFile(userPath, "utf-8");
      return c.json({ content });
    } catch (err) {
      // 文件不存在时返回空字符串（user.md 是可选的）
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 user.md 内容，并触发 system prompt 重建
  route.put("/user-profile", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      const userPath = path.join(engine.userDir, "user.md");
      await fs.writeFile(userPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/user-profile (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/user-profile failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 置顶记忆（pinned.md）──

  // 读取 pinned.md，解析为逐条数组
  route.get("/pinned", async (c) => {
    try {
      const pinnedPath = path.join(resolveAgent(engine, c).agentDir, "pinned.md");
      let content = "";
      try {
        content = await fs.readFile(pinnedPath, "utf-8");
      } catch (err) {
        if (err.code === "ENOENT") return c.json({ pins: [] });
        throw err;
      }
      const pins = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^-\s*/, ""));
      return c.json({ pins });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 pinned.md（覆盖写入），触发 system prompt 重建
  route.put("/pinned", async (c) => {
    try {
      const body = await safeJson(c);
      const { pins } = body;
      if (!Array.isArray(pins)) {
        return c.json({ error: "pins must be an array" }, 400);
      }
      const content = pins
        .map(p => (typeof p === "string" ? p.trim() : ""))
        .filter(p => p.length > 0)
        .map(p => `- ${p}`)
        .join("\n")
        + "\n";
      const agent = resolveAgentStrict(engine, c);
      const pinnedPath = path.join(agent.agentDir, "pinned.md");
      await fs.writeFile(pinnedPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/pinned (${pins.length} items)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 pinned.md）
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      debugLog()?.error("api", `PUT /api/pinned failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 记忆管理 ──

  /**
   * 获取指定 agent 的 FactStore。
   * 如果 agentId 就是当前 active agent，直接用 engine.factStore；
   * 否则临时打开那个 agent 的 facts.db。
   * 返回 { store, isTemp }，调用方用完 isTemp===true 的 store 需要 close。
   */
  function getStoreForAgent(agentId) {
    if (!agentId) throw new Error("agentId is required");
    const resolvedId = agentId;
    const agent = engine.getAgent(resolvedId);
    if (agent?.factStore) {
      return { store: agent.factStore, isTemp: false };
    }
    if (/[/\\.]/.test(resolvedId)) throw new Error("Invalid agent ID");
    const dbPath = path.join(engine.agentsDir, resolvedId, "memory", "facts.db");
    try {
      const store = new FactStore(dbPath);
      return { store, isTemp: true };
    } catch (err) {
      throw new Error(`Cannot open fact DB for agent "${resolvedId}": ${err.message}`);
    }
  }

  // 获取所有元事实
  route.get("/memories/health", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      return c.json({
        agentId: agent.id,
        ...buildMemoryHealth(agent),
      });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/memories", async (c) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      return c.json({ memories: store.exportAll() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 读取编译后的 memory.md
  route.get("/memories/compiled", async (c) => {
    try {
      const agent = resolveAgent(engine, c);
      const editableFactsEnabled = isEditableMemoryEnabled(engine);
      const sections = readCompiledMemorySections(path.dirname(agent.memoryMdPath), {
        editableFactsEnabled,
        summaryManager: agent.summaryManager,
      });
      const content = editableFactsEnabled
        ? buildCompiledMemoryMarkdown(sections)
        : await fs.readFile(agent.memoryMdPath, "utf-8").catch(() => "");
      return c.json({ content, editableFactsEnabled, sections });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 清除编译产物（today/week/longterm/facts/memory.md + fingerprints）
  route.put("/memories/compiled/facts", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      if (!isEditableMemoryEnabled(engine)) {
        return c.json({ error: "editable memory experiment is disabled" }, 400);
      }
      const body = await safeJson(c);
      if (typeof body?.facts !== "string") {
        return c.json({ error: "facts must be a string" }, 400);
      }
      const memDir = path.dirname(agent.memoryMdPath);
      const normalizedFacts = writeEditableFactsSection(memDir, body.facts, {
        summaryManager: agent.summaryManager,
        memoryMdPath: agent.memoryMdPath,
      });
      debugLog()?.log("api", `PUT /api/memories/compiled/facts agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true, facts: normalizedFacts });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/memories/compiled", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const memDir = path.dirname(agent.memoryMdPath);
      writeCompiledResetMarker(memDir);
      clearCompiledMemoryArtifacts(memDir);
      clearCompiledSummarySources(agent.summariesDir, agent.summaryManager);
      debugLog()?.log("api", `DELETE /api/memories/compiled agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 清除所有记忆（facts.db + memory.md）
  route.delete("/memories", async (c) => {
    let tempStore = null;
    try {
      const agent = resolveAgentStrict(engine, c);
      const { store, isTemp } = getStoreForAgent(agent.id);
      if (isTemp) tempStore = store;
      const memDir = path.dirname(agent.memoryMdPath);
      writeCompiledResetMarker(memDir);
      store.clearAll();
      clearCompiledMemoryArtifacts(memDir);
      clearCompiledSummarySources(agent.summariesDir, agent.summaryManager);
      debugLog()?.log("api", `DELETE /api/memories agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 导出记忆（JSON）
  route.get("/memories/export", async (c) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      return c.json({
        version: 2,
        exportedAt: new Date().toISOString(),
        facts: store.exportAll(),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 导入记忆（直接写入，无需 embedding）
  route.post("/memories/import", async (c) => {
    let tempStore = null;
    try {
      const body = await safeJson(c);
      const { facts, memories } = body;
      // 兼容 v1 导出格式（memories 字段）和 v2 格式（facts 字段）
      const entries = facts || memories;
      if (!Array.isArray(entries) || entries.length === 0) {
        return c.json({ error: "facts must be a non-empty array" }, 400);
      }

      const importEntries = entries.map((e) => ({
        fact: e.fact || e.content || "",
        tags: e.tags || [],
        time: e.time || e.date || null,
        session_id: e.session_id || "imported",
      }));

      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      store.importAll(importEntries);
      debugLog()?.log("api", `POST /api/memories/import: ${importEntries.length} entries`);
      return c.json({ ok: true, imported: importEntries.length });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // ── 搜索 API Key 验证 ──

  route.post("/search/verify", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    const selectedProvider = body.search_provider || provider;
    if (!provider) {
      return c.json({ ok: false, error: "provider is required" }, 400);
    }
    const existingSearch = engine.getSearchConfig?.() || {};
    const api_key = isMaskedSecretValue(body.api_key)
      ? existingSearch.api_keys?.[provider] || existingSearch.api_key || ""
      : body.api_key || "";
    try {
      const { searchProviderRequiresApiKey, verifySearchKey } = await import("../../lib/tools/web-search.ts");
      if (searchProviderRequiresApiKey(provider) && !api_key) {
        return c.json({ ok: false, error: "api_key is required" }, 400);
      }
      await verifySearchKey(provider, api_key);
      const storedApiKey = searchProviderRequiresApiKey(provider) ? api_key : "";
      const apiKeys = normalizeSearchApiKeys(existingSearch.api_keys || {});
      if (isSearchApiProvider(provider)) {
        if (storedApiKey) apiKeys[provider] = storedApiKey;
        else delete apiKeys[provider];
      }
      const selectedApiKey = isSearchApiProvider(selectedProvider) ? apiKeys[selectedProvider] || "" : "";
      engine.setSearchConfig({ provider: selectedProvider, api_key: selectedApiKey, api_keys: apiKeys });
      await engine.updateConfig({ search: { provider: selectedProvider, api_key: selectedApiKey, api_keys: apiKeys } });
      debugLog()?.log("api", `POST /api/search/verify provider=${provider} selected=${selectedProvider} (ok)`);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.warn("api", `POST /api/search/verify provider=${provider} failed: ${err.message}`);
      return c.json({ ok: false, error: err.message });
    }
  });

  return route;
}

async function gcConfigWorkspacePersistence(engine) {
  if (typeof engine.gcWorkspacePersistence === "function") {
    await engine.gcWorkspacePersistence({ agentId: engine.currentAgentId || undefined });
    return;
  }
  const result = pruneMissingWorkspaceConfig(engine.config || {});
  if (result.changed && typeof engine.updateConfig === "function") {
    await engine.updateConfig(result.patch);
  }
}
