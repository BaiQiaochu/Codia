// @ts-nocheck
/**
 * desk.js — Desk 系统 REST API
 *
 * 提供 cron 任务、工作空间文件的 HTTP 接口。
 * 前端通过这些接口直接操作（不经过 agent/LLM），
 * agent 通过 tool 操作（走 WebSocket 推送更新）。
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { Hono } from "hono";
import { createAutomationRunService, readAutomationHealth } from "../../lib/desk/automation-health.ts";
import { safeJson } from "../hono-helpers.ts";
import { parseSkillMetadata } from "../../lib/skills/skill-metadata.ts";
import { installSkillPackageFromPath } from "../../lib/skills/skill-package-installer.ts";
import { materializeUploadedSkillPackage } from "../utils/uploaded-skill-package.ts";
import { WORKSPACE_SKILL_DIRS } from "../../shared/workspace-skill-paths.ts";
import { DEFAULT_DISABLED_TOOL_NAMES } from "../../shared/tool-categories.ts";
import { applyMarkdownCoverFromGeneratedFile } from "../../plugins/beautify/lib/markdown-cover-service.ts";
import { buildCoverStyleGuideForAgent } from "../../plugins/beautify/lib/cover-style-guide.ts";
import { resolveCoverGalleryPresetImagePath } from "../../plugins/beautify/lib/cover-gallery-assets.ts";
import { createSubmitContext } from "../../plugins/image-gen/lib/image-task-runner.ts";
import { callText } from "../../core/llm-client.ts";
import { emitAppEvent } from "../app-events.ts";
import { t } from "../../lib/i18n.ts";
import { resolveAgent } from "../utils/resolve-agent.ts";
import { realPath, isSensitivePath } from "../utils/path-security.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { jsonRouteError } from "../http/route-errors.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { createRequestContext } from "../http/boundary.ts";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import {
  buildXmindWorkbook,
  extractDocumentTextForMindmap,
  generateMindmapFromDocument,
  sanitizeXmindName,
  uniqueFileName,
} from "../../plugins/mind-map/lib/mind-map-operations.ts";

/** 安全路径校验：target 必须在 baseDir 内部（解析 symlink 后比较） */
function isInsidePath(target: any, baseDir: any) {
  const base = realPath(baseDir);
  if (!base) return false;
  const resolved = realPath(target);
  if (resolved) return resolved === base || resolved.startsWith(base + path.sep);
  // 路径不存在（mkdir / rename 目标）：解析父目录 + 保留 basename
  const parentResolved = realPath(path.dirname(target));
  if (!parentResolved) return false;
  const full = path.join(parentResolved, path.basename(target));
  return full === base || full.startsWith(base + path.sep);
}

/** 列出工作空间目录下的文件（异步） */
async function listWorkspaceFiles(dir: any) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 目录不存在 → 空列表；权限错误等真实异常 → 向上抛
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const items = await Promise.all(
    entries
      .filter(e => !e.name.startsWith("."))
      .map(async (e) => {
        const fullPath = path.join(dir, e.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return {
            name: e.name,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            isDir: e.isDirectory(),
          };
        } catch (err) {
          // ENOENT = 文件在 readdir 后被删除，正常跳过；其他错误也跳过单项不影响整体
          if (err.code !== "ENOENT") console.warn(`[desk] stat failed for ${e.name}: ${err.message}`);
          return null;
        }
      })
  );
  return items.filter(Boolean).sort((a: any, b: any) => Date.parse(b.mtime) - Date.parse(a.mtime));
}

function isInsideAnyRoot(dir: any, roots: any[]) {
  const resolved = realPath(dir);
  if (!resolved) return false;
  return roots.filter(Boolean).some(root => {
    const r = realPath(root);
    if (!r) return false;
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function selectedAgentDeskRoots(engine: any, agentId: any) {
  if (!agentId || typeof agentId !== "string") return [];
  return [
    typeof engine.getExplicitHomeCwd === "function" ? engine.getExplicitHomeCwd(agentId) : null,
    typeof engine.getHomeCwd === "function" ? engine.getHomeCwd(agentId) : null,
  ].filter(Boolean);
}

function isApprovedDir(dir: any, engine: any, { agentId = null }: any = {}) {
  if (isInsideAnyRoot(dir, selectedAgentDeskRoots(engine, agentId))) {
    return true;
  }
  if (typeof engine.isApprovedDeskDir === "function") {
    return engine.isApprovedDeskDir(dir, { agentId });
  }
  const approved = [
    engine.defaultDeskCwd,
    engine.deskCwd,
    engine.homeCwd,
    ...(Array.isArray(engine.config?.cwd_history) ? engine.config.cwd_history : []),
  ].filter(Boolean);
  if (typeof engine.isApprovedWorkspaceDir === "function" && engine.isApprovedWorkspaceDir(dir, { agentId })) {
    return true;
  }
  return isInsideAnyRoot(dir, approved);
}

function defaultDeskDir(engine) {
  return engine.defaultDeskCwd || engine.deskCwd || engine.homeCwd || "";
}

function isPlainEntryName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function deskRouteError(c, code, message, status) {
  return jsonRouteError(c, { code, message, status });
}

function getCronStore(engine, c) {
  if (typeof engine.getStudioCronStore === "function") {
    const store = engine.getStudioCronStore();
    if (store) return store;
  }
  try {
    const agent = resolveAgent(engine, c);
    if (agent?.cronStore) return agent.cronStore;
  } catch {}
  const agent = engine.getAgent?.(engine.currentAgentId) || engine.agent;
  return agent?.cronStore || null;
}

function normalizeRouteExecutionContext(value, actorAgentId, engine) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      kind: typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "api_request",
      cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : defaultDeskDir(engine) || null,
      workspaceFolders: Array.isArray(value.workspaceFolders)
        ? value.workspaceFolders.filter(p => typeof p === "string" && p.trim())
        : [],
      sourceSessionPath: typeof value.sourceSessionPath === "string" && value.sourceSessionPath.trim()
        ? value.sourceSessionPath
        : null,
      createdByAgentId: typeof value.createdByAgentId === "string" && value.createdByAgentId.trim()
        ? value.createdByAgentId
        : actorAgentId,
    };
  }
  const cwd = defaultDeskDir(engine) || null;
  return {
    kind: "api_request",
    cwd,
    workspaceFolders: cwd ? [cwd] : [],
    sourceSessionPath: null,
    createdByAgentId: actorAgentId || null,
  };
}

function normalizeRouteCreatedBy(value, actorAgentId) {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.kind === "string") {
    return JSON.parse(JSON.stringify(value));
  }
  return { kind: "agent", agentId: actorAgentId || null };
}

function normalizeRouteExecutor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}

function validateRouteExecutor(executor) {
  if (!executor) return null;
  if (executor.kind === "agent_session") return null;
  throw new Error(`unsupported automation executor: ${executor.kind}`);
}

const WORKSPACE_SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);
const WORKSPACE_SEARCH_LIMIT = 80;
const BEAUTIFY_OPTIONAL_TOOL_NAME = "beautify";
const MAX_COVER_UPLOAD_BYTES = 25 * 1024 * 1024;

function toRelativeSubdir(root, target) {
  const rel = path.relative(root, target);
  return rel.split(path.sep).filter(Boolean).join("/");
}

async function searchWorkspaceFiles(root, query, { limit = WORKSPACE_SEARCH_LIMIT } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const results = [];

  async function walk(dir) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "EACCES") {
        console.warn(`[desk] search readdir failed for ${dir}: ${err.message}`);
      }
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (isDir && WORKSPACE_SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const relativePath = toRelativeSubdir(root, fullPath);
      const parentSubdir = toRelativeSubdir(root, path.dirname(fullPath));

      if (entry.name.toLowerCase().includes(needle)) {
        try {
          const stat = await fs.promises.stat(fullPath);
          results.push({
            name: entry.name,
            relativePath,
            parentSubdir,
            isDir,
            size: isDir ? null : stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch (err) {
          if (err.code !== "ENOENT") console.warn(`[desk] search stat failed for ${entry.name}: ${err.message}`);
        }
      }

      if (isDir) await walk(fullPath);
    }
  }

  await walk(root);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh")).slice(0, limit);
}

export function createDeskRoute(engine: any, hub: any) {
  const automationRuns = createAutomationRunService();
  const route = new Hono<any>();

  /** 从所有 agent 的 activityStore 中按 ID 查找 entry */
  function findActivityEntry(activityId) {
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const entry = store?.get(activityId);
      if (entry) return { entry, agentId: ag.id };
    }
    return { entry: null, agentId: null };
  }

  function emitActivityUpdate(activity, sessionPath = null) {
    hub?.eventBus?.emit?.({ type: "activity_update", activity }, sessionPath);
  }

  function emitActivityUpdates(activities) {
    if (!Array.isArray(activities)) return;
    for (const activity of activities) {
      emitActivityUpdate(activity);
    }
  }

  function beautifyImageModelPromptLines(imageModel) {
    const provider = typeof imageModel?.providerId === "string" && imageModel.providerId.trim()
      ? imageModel.providerId.trim()
      : typeof imageModel?.provider === "string" && imageModel.provider.trim() ? imageModel.provider.trim() : "";
    const model = typeof imageModel?.modelId === "string" && imageModel.modelId.trim()
      ? imageModel.modelId.trim()
      : typeof imageModel?.id === "string" && imageModel.id.trim() ? imageModel.id.trim() : "";
    if (!provider || !model) return [];
    return [
      "   - provider: " + provider,
      "   - model: " + model,
      "   - 必须把 provider 和 model 显式传给 media_generate-image，不要依赖默认媒体模型。",
    ];
  }

  function buildBeautifyCoverPrompt({ filePath, themeTone, userGuidance, imageModel = null }) {
    const styleGuide = buildCoverStyleGuideForAgent({ themeTone, userGuidance });
    const imageModelLines = beautifyImageModelPromptLines(imageModel);
    return [
      "这是一个由编辑器 UI 按钮发起的 Beautify 后台任务，目标 Markdown 路径已经由按钮明确给出。",
      `目标文件：${filePath}`,
      "",
      "请按这个顺序完成：",
      "1. 阅读目标 Markdown 文件，理解文章内容和情绪。",
      "2. 你自己写一条给生图模型使用的英文提示词。",
      "3. 调用 media_generate-image 生成 1 张图片，ratio 固定传 3:2，resolution 传 2k。",
      ...imageModelLines,
      "4. 用 wait 和 check_pending_tasks 查询本会话的图片生成任务，直到任务 resolved 或失败。",
      "5. 图片生成成功后，从 resolved 结果的 sessionFiles[0].filePath 取生成图片绝对路径。",
      "6. 调用 beautify_create-cover，把生成图片应用到 Markdown：",
      `   - targetFilePath: ${filePath}`,
      "   - generatedFilePath: <上一步生成图片的绝对路径>",
      "",
      styleGuide,
      "",
      "边界：Beautify 工具只负责把已有图片复制到附件文件夹并写入 cover frontmatter。图片来源未来也可以是内置头图库或用户本地图片，但当前按钮任务默认走生图工具。不要用 Beautify 工具生成提示词或提交生图任务，不要把生图 prompt、模型、provider、生成时间写进 Markdown。",
      "完成后用一句话说明图片已经应用为 cover，或说明失败原因。",
    ].filter(Boolean).join("\n");
  }

  function getBeautifyExecutorAgent(requestedAgentId) {
    const agentId = typeof requestedAgentId === "string" && requestedAgentId.trim()
      ? requestedAgentId.trim()
      : (engine.getPrimaryAgentId?.() || engine.currentAgentId || null);
    const agent = agentId ? engine.getAgent?.(agentId) : null;
    return {
      agent: agent || null,
      agentId: agent?.id || agentId || null,
    };
  }

  function getBeautifyCoverTool() {
    const pluginManager = engine.pluginManager;
    return pluginManager?.getPluginTool?.(BEAUTIFY_OPTIONAL_TOOL_NAME, "create-cover")
      || (pluginManager?.getAllTools?.() || []).find((tool) => (
        tool?._pluginId === BEAUTIFY_OPTIONAL_TOOL_NAME
        && (tool.name === "beautify_create-cover" || tool.name === "create-cover")
      ))
      || null;
  }

  function isBeautifyPluginAvailable() {
    return (engine.pluginManager?.getAllTools?.() || [])
      .some((tool) => tool?._pluginId === BEAUTIFY_OPTIONAL_TOOL_NAME);
  }

  function hasMarkdownCoverSystemSupport() {
    return true;
  }

  function isBeautifyEnabled(agent) {
    const disabled = Array.isArray(agent?.config?.tools?.disabled)
      ? agent.config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES;
    return !disabled.includes(BEAUTIFY_OPTIONAL_TOOL_NAME);
  }

  function beautifyAgentName(agent, agentId) {
    return agent?.agentName || agent?.name || agentId || null;
  }

  function getImageGenContext() {
    return engine.pluginManager?.getPlugin?.("image-gen")?.ctx || null;
  }

  function normalizeImageModelRef(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const provider = typeof value.provider === "string" && value.provider.trim()
      ? value.provider.trim()
      : typeof value.providerId === "string" && value.providerId.trim() ? value.providerId.trim() : "";
    const id = typeof value.id === "string" && value.id.trim()
      ? value.id.trim()
      : typeof value.modelId === "string" && value.modelId.trim() ? value.modelId.trim() : "";
    if (!provider || !id) return null;
    return {
      provider,
      id,
      ...(typeof value.credentialLaneId === "string" && value.credentialLaneId.trim()
        ? { credentialLaneId: value.credentialLaneId.trim() }
        : {}),
    };
  }

  function providerModelList(provider) {
    if (!provider || typeof provider !== "object") return [];
    if (Array.isArray(provider.models)) return provider.models;
    if (Array.isArray(provider.imageModels)) return provider.imageModels;
    if (Array.isArray(provider.availableImageModels)) return provider.availableImageModels;
    if (Array.isArray(provider.availableModels)) {
      return provider.availableModels.filter((model) => !model?.type || model.type === "image");
    }
    return [];
  }

  function refsFromMediaProviders(providers) {
    const refs = [];
    const entries = providers && typeof providers === "object" ? Object.entries(providers) : [];
    for (const [key, provider] of entries) {
      if (provider?.hasCredentials === false) continue;
      const providerId = typeof provider?.providerId === "string" && provider.providerId.trim()
        ? provider.providerId.trim()
        : String(key || "").trim();
      if (!providerId) continue;
      for (const model of providerModelList(provider)) {
        const modelId = typeof model?.id === "string" && model.id.trim() ? model.id.trim() : "";
        if (!modelId) continue;
        refs.push({
          provider: providerId,
          id: modelId,
          ...(typeof model?.credentialLaneId === "string" && model.credentialLaneId.trim()
            ? { credentialLaneId: model.credentialLaneId.trim() }
            : {}),
        });
      }
    }
    return refs;
  }

  async function listAvailableImageModelRefs(submitCtx) {
    try {
      const result = await submitCtx.bus?.request?.("provider:media-providers", { capability: "image_generation" });
      const providers = result?.providers && typeof result.providers === "object" ? result.providers : {};
      return refsFromMediaProviders(providers);
    } catch {
      return [];
    }
  }

  async function checkImageModelRef({ submitCtx, registry, ref }) {
    let resolvedMedia = null;
    if (submitCtx.bus?.request) {
      const resolved = await submitCtx.bus.request("provider:resolve-media-model", {
        providerId: ref.provider,
        modelId: ref.id,
        capability: "image_generation",
        ...(ref.credentialLaneId ? { credentialLaneId: ref.credentialLaneId } : {}),
      });
      if (resolved?.error) return { ok: false, error: resolved.error };
      if (!resolved?.protocolId) {
        return { ok: false, error: `media model "${ref.provider}/${ref.id}" missing protocolId` };
      }
      resolvedMedia = resolved;
    }

    const adapter = (resolvedMedia?.protocolId ? registry.getProtocol?.(resolvedMedia.protocolId) : null)
      || registry.get?.(resolvedMedia?.providerId || ref.provider)
      || registry.get?.(ref.provider);
    if (!adapter) {
      return { ok: false, error: `default image model provider "${ref.provider}" is unavailable` };
    }
    if (typeof adapter.checkAuth === "function") {
      const auth = await adapter.checkAuth(submitCtx);
      if (auth?.ok === false) {
        return { ok: false, error: auth.message || "image model credentials unavailable" };
      }
    }

    return {
      ok: true,
      resolved: resolvedMedia || { providerId: ref.provider, modelId: ref.id },
    };
  }

  function getNativeImageGenerationRuntime() {
    if (!engine.media) return null;
    return {
      config: {
        get(key) {
          if (key === "defaultImageModel") {
            return engine.media?.getImageConfig?.()?.defaultImageModel;
          }
          if (key === "providerDefaults") {
            return engine.media?.getImageConfig?.()?.providerDefaults || {};
          }
          return undefined;
        },
      },
      async listAvailableRefs() {
        const result = await engine.media?.listImageProviders?.();
        return refsFromMediaProviders(result?.providers || {});
      },
      async check(ref) {
        try {
          const resolved = engine.media.resolveImageModelRef({
            providerId: ref.provider,
            modelId: ref.id,
            ...(ref.credentialLaneId ? { credentialLaneId: ref.credentialLaneId } : {}),
          });
          return { ok: true, resolved };
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
      },
    };
  }

  function getPluginImageGenerationRuntime() {
    const imageGenCtx = getImageGenContext();
    if (!imageGenCtx) return null;

    const registry = imageGenCtx._mediaGen?.registry;
    if (!registry) {
      return {
        unavailableReason: "image-gen-unavailable",
        unavailableMessage: "image generation runtime is unavailable",
      };
    }

    const submitCtx = createSubmitContext(imageGenCtx);
    return {
      config: imageGenCtx.config,
      listAvailableRefs: () => listAvailableImageModelRefs(submitCtx),
      check: (ref) => checkImageModelRef({ submitCtx, registry, ref }),
    };
  }

  async function resolveDefaultImageModelStatus() {
    const runtimes = [
      getNativeImageGenerationRuntime(),
      getPluginImageGenerationRuntime(),
    ].filter(Boolean);

    if (!runtimes.length) {
      return {
        ok: false,
        reason: "image-gen-unavailable",
        error: "image generation runtime is unavailable",
        settingsTarget: "media",
      };
    }

    const unavailable = runtimes.find((runtime) => runtime.unavailableReason);
    if (unavailable && runtimes.length === 1) {
      return {
        ok: false,
        reason: unavailable.unavailableReason,
        error: unavailable.unavailableMessage || "image generation runtime is unavailable",
        settingsTarget: "media",
      };
    }

    let defaultModel = null;
    let defaultError = "";

    try {
      for (const runtime of runtimes) {
        if (runtime.unavailableReason) continue;
        const candidateDefault = normalizeImageModelRef(runtime.config?.get?.("defaultImageModel"));
        if (!candidateDefault) continue;
        if (!defaultModel) defaultModel = candidateDefault;
        const checkedDefault = await runtime.check(candidateDefault);
        if (checkedDefault.ok) return { ok: true, resolved: checkedDefault.resolved };
        if (!defaultError) defaultError = checkedDefault.error || "";
      }

      for (const runtime of runtimes) {
        if (runtime.unavailableReason) continue;
        for (const ref of await runtime.listAvailableRefs()) {
          const checked = await runtime.check(ref);
          if (checked.ok) {
            return {
              ok: true,
              resolved: checked.resolved,
              ...(defaultError ? { fallbackFrom: defaultModel, fallbackReason: defaultError } : {}),
            };
          }
        }
      }

      if (!defaultModel) {
        return {
          ok: false,
          reason: "default-image-model-missing",
          error: "default image model is not configured",
          settingsTarget: "media",
        };
      }
      throw new Error(defaultError || `default image model "${defaultModel.provider}/${defaultModel.id}" is unavailable`);
    } catch (err) {
      return {
        ok: false,
        reason: "default-image-model-invalid",
        error: err?.message || String(err),
        settingsTarget: "media",
      };
    }
  }

  async function getBeautifyGenerationStatus(requestedAgentId, options = {}) {
    const { agent, agentId } = getBeautifyExecutorAgent(requestedAgentId);
    const base = {
      available: false,
      enabled: false,
      executorAgentId: agentId,
      executorAgentName: beautifyAgentName(agent, agentId),
      disabledReason: null,
      message: null,
      settingsTarget: null,
    };

    if (!agentId || !agent) {
      return {
        ...base,
        disabledReason: "agent-unavailable",
        message: "agent unavailable",
      };
    }

    if (!isBeautifyPluginAvailable()) {
      return {
        ...base,
        disabledReason: "beautify-plugin-unavailable",
        message: "beautify tool is unavailable",
        settingsTarget: "plugins",
      };
    }

    if (!options.ignoreAgentBeautifyDisabled && !isBeautifyEnabled(agent)) {
      return {
        ...base,
        available: true,
        disabledReason: "beautify-disabled",
        message: "beautify tool is disabled for this agent",
        settingsTarget: "agent-tools",
      };
    }

    const imageStatus = await resolveDefaultImageModelStatus();
    if (!imageStatus.ok) {
      return {
        ...base,
        available: true,
        disabledReason: imageStatus.reason,
        message: imageStatus.error,
        settingsTarget: imageStatus.settingsTarget,
      };
    }

    return {
      ...base,
      available: true,
      enabled: true,
      imageModel: imageStatus.resolved || null,
      ...(imageStatus.fallbackFrom ? { imageModelFallbackFrom: imageStatus.fallbackFrom } : {}),
      ...(imageStatus.fallbackReason ? { imageModelFallbackReason: imageStatus.fallbackReason } : {}),
    };
  }

  // ════════════════════════════
  //  助手活动
  // ════════════════════════════

  /** 活动列表（合并所有 agent） */
  function validateBeautifyMarkdownFilePath(filePath) {
    if (!filePath || !path.isAbsolute(filePath)) {
      return "filePath must be an absolute Markdown file path";
    }
    if (path.extname(filePath).toLowerCase() !== ".md") {
      return "filePath must point to a .md file";
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return "filePath must point to a file";
    } catch (err) {
      return `filePath is not readable: ${err.message}`;
    }
    return null;
  }

  function validateMarkdownCoverSystemAccess() {
    if (!hasMarkdownCoverSystemSupport()) {
      return { error: "beautify tool is unavailable", status: 404 };
    }
    return {};
  }

  function canUseLocalAbsolutePaths(c) {
    const principal = readAuthPrincipal(c);
    return !principal || principal.kind === "unknown" || isLocalOwnerPrincipal(principal);
  }

  function fileServiceForRequest(c) {
    const requestContext = createRequestContext(c, engine);
    return new MountAwareFileService({
      codiaHome: engine.codiaHome,
      defaultRoot: defaultDeskDir(engine),
      studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
      createCheckpoint: typeof engine.createUserEditCheckpoint === "function"
        ? (args) => engine.createUserEditCheckpoint(args)
        : null,
    });
  }

  function normalizeWorkbenchCoverTarget(body) {
    const raw = body?.target || body?.remoteContentRef || null;
    if (!raw) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw coverRouteError("target must be a workbench file target", "invalid_target", 400);
    }
    if (raw.kind !== "workbench-file" && raw.kind !== "mobile-workbench") {
      throw coverRouteError("target.kind must be workbench-file", "invalid_target", 400);
    }
    const mountId = typeof raw.mountId === "string" && raw.mountId.trim()
      ? raw.mountId.trim()
      : (typeof raw.rootId === "string" && raw.rootId.trim() ? raw.rootId.trim() : "default");
    return {
      kind: "workbench-file",
      mountId,
      rootId: typeof raw.rootId === "string" && raw.rootId.trim() ? raw.rootId.trim() : mountId,
      subdir: typeof raw.subdir === "string" ? raw.subdir : "",
      name: typeof raw.name === "string" ? raw.name : "",
    };
  }

  function resolveBeautifyMarkdownTarget(c, body) {
    try {
      const target = normalizeWorkbenchCoverTarget(body);
      if (target) {
        const resolved = fileServiceForRequest(c).writeFileTarget(target.mountId, target.subdir, target.name);
        const fileError = validateBeautifyMarkdownFilePath(resolved.target);
        if (fileError) return { error: fileError, status: 400 };
        return {
          filePath: resolved.target,
          target: {
            kind: "workbench-file",
            mountId: resolved.root?.mountId || resolved.root?.id || target.mountId,
            rootId: resolved.root?.id || target.rootId,
            subdir: target.subdir,
            name: resolved.filename,
          },
        };
      }

      const filePath = typeof body?.filePath === "string" ? body.filePath : "";
      if (!canUseLocalAbsolutePaths(c)) {
        return { error: "filePath requires local owner; use target for remote clients", status: 403 };
      }
      const fileError = validateBeautifyMarkdownFilePath(filePath);
      if (fileError) return { error: fileError, status: 400 };
      return { filePath, target: null };
    } catch (err) {
      if (err instanceof MountAwareFileError) {
        return { error: err.message, status: err.status };
      }
      return { error: err?.message || String(err), status: err?.status || 400 };
    }
  }

  function resolveLocalCoverImagePath(c, body) {
    const imageFilePath = typeof body?.imageFilePath === "string"
      ? body.imageFilePath
      : typeof body?.generatedFilePath === "string" ? body.generatedFilePath : "";
    if (!imageFilePath) return null;
    if (!canUseLocalAbsolutePaths(c)) {
      return { error: "imageFilePath requires local owner; upload image.contentBase64 for remote clients", status: 403 };
    }
    if (!path.isAbsolute(imageFilePath)) {
      return { error: "imageFilePath must be an absolute image file path", status: 400 };
    }
    return { filePath: imageFilePath, cleanup: null };
  }

  function writeUploadedCoverImage(body) {
    const image = body?.image && typeof body.image === "object" && !Array.isArray(body.image)
      ? body.image
      : null;
    const contentBase64 = typeof image?.contentBase64 === "string" ? image.contentBase64 : "";
    if (!contentBase64) return null;

    const base64 = contentBase64.includes(",") ? contentBase64.split(",").pop() : contentBase64;
    const buffer = Buffer.from(String(base64 || ""), "base64");
    if (buffer.byteLength === 0) {
      return { error: "image.contentBase64 is empty", status: 400 };
    }
    if (buffer.byteLength > MAX_COVER_UPLOAD_BYTES) {
      return { error: "image file too large", status: 413 };
    }

    const filename = typeof image.filename === "string" && image.filename.trim()
      ? image.filename.trim()
      : typeof image.name === "string" && image.name.trim() ? image.name.trim() : "cover.png";
    const ext = path.extname(filename).toLowerCase() || ".png";
    const uploadRoot = path.join(engine.codiaHome || os.tmpdir(), "tmp", "markdown-cover-uploads");
    fs.mkdirSync(uploadRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(uploadRoot, "cover-"));
    const filePath = path.join(tempDir, `upload-${crypto.randomBytes(4).toString("hex")}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return {
      filePath,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  function coverImageFromRequest(c, body) {
    const local = resolveLocalCoverImagePath(c, body);
    if (local) return local;
    const uploaded = writeUploadedCoverImage(body);
    if (uploaded) return uploaded;
    return { error: "imageFilePath or image.contentBase64 is required", status: 400 };
  }

  function coverRouteError(message, code, status) {
    const err: any = new Error(message);
    err.code = code;
    err.status = status;
    return err;
  }

  function emitMarkdownCoverUpdated(targetInfo) {
    if (targetInfo.target) {
      emitAppEvent(engine, "markdown-cover-updated", { target: targetInfo.target });
    } else {
      emitAppEvent(engine, "markdown-cover-updated", { filePath: targetInfo.filePath });
    }
  }

  async function validateBeautifyGenerationAccess(body) {
    const status = await getBeautifyGenerationStatus(body?.executorAgentId || body?.agentId, {
      ignoreAgentBeautifyDisabled: true,
    });
    if (!status.executorAgentId) return { error: "agent unavailable", status: 500, reason: "agent-unavailable" };
    if (!status.enabled) {
      const httpStatus = status.disabledReason === "beautify-disabled"
        ? 403
        : status.disabledReason === "beautify-plugin-unavailable" || status.disabledReason === "image-gen-unavailable"
          ? 404
          : 409;
      return {
        error: status.message || "beautify generation is unavailable",
        status: httpStatus,
        reason: status.disabledReason,
        settingsTarget: status.settingsTarget,
      };
    }
    const agent = engine.getAgent?.(status.executorAgentId);
    return { agent, agentId: status.executorAgentId, imageModel: status.imageModel || null };
  }

  route.get("/desk/beautify/status", async (c) => {
    const systemCover = { available: hasMarkdownCoverSystemSupport() };
    const requestedAgentId = c.req.query("executorAgentId") || c.req.query("agentId");
    const agentGenerate = await getBeautifyGenerationStatus(requestedAgentId, {
      ignoreAgentBeautifyDisabled: !requestedAgentId,
    });
    return c.json({
      systemCover,
      agentGenerate,
      available: systemCover.available,
      enabled: agentGenerate.enabled,
      agentId: agentGenerate.executorAgentId,
    });
  });

  route.post("/desk/beautify/cover/apply", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);

    const access = validateMarkdownCoverSystemAccess();
    if (access.error) return c.json({ error: access.error }, access.status as any);

    const image = coverImageFromRequest(c, body);
    if (image.error) return c.json({ error: image.error }, image.status as any);

    try {
      const result = await applyMarkdownCoverFromGeneratedFile({
        markdownFilePath: targetInfo.filePath,
        generatedFilePath: image.filePath,
      });
      emitMarkdownCoverUpdated(targetInfo);
      return c.json({
        ok: true,
        ...(targetInfo.target ? { target: targetInfo.target } : {}),
        cover: result.cover,
        beautifyCover: result,
      });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    } finally {
      image.cleanup?.();
    }
  });

  route.post("/desk/beautify/cover/preset/apply", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);

    const access = validateMarkdownCoverSystemAccess();
    if (access.error) return c.json({ error: access.error }, access.status as any);

    const presetId = typeof body?.presetId === "string" ? body.presetId : "";
    let imageFilePath;
    try {
      imageFilePath = resolveCoverGalleryPresetImagePath(presetId);
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }

    try {
      const result = await applyMarkdownCoverFromGeneratedFile({
        markdownFilePath: targetInfo.filePath,
        generatedFilePath: imageFilePath,
      });
      emitMarkdownCoverUpdated(targetInfo);
      return c.json({
        ok: true,
        ...(targetInfo.target ? { target: targetInfo.target } : {}),
        cover: result.cover,
        beautifyCover: result,
      });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  route.post("/desk/beautify/cover", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);
    const filePath = targetInfo.filePath;

    const access = await validateBeautifyGenerationAccess(body);
    if (access.error) {
      return c.json({
        error: access.error,
        ...(access.reason ? { reason: access.reason } : {}),
        ...(access.settingsTarget ? { settingsTarget: access.settingsTarget } : {}),
      }, access.status as any);
    }
    const { agent, agentId, imageModel } = access;

    const activityId = `beautify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const activityDir = path.join(engine.agentsDir, agentId, "activity");
    const store = engine.getActivityStore(agentId);
    const activity = store.add({
      id: activityId,
      type: "beautify",
      label: "Markdown cover",
      status: "running",
      agentId,
      agentName: agent?.agentName || agent?.name || agentId,
      summary: `正在为 ${path.basename(filePath)} 生成 cover`,
      startedAt: Date.now(),
      finishedAt: null,
      sessionFile: null,
      targetFilePath: filePath,
    });
    emitActivityUpdate(activity);

    const themeTone = body?.themeTone === "dark" ? "dark" : "light";
    const userGuidance = typeof body?.userGuidance === "string" ? body.userGuidance.trim() : "";
    const extraCustomTools = !isBeautifyEnabled(agent)
      ? [getBeautifyCoverTool()].filter(Boolean)
      : [];
    void engine.executeIsolated(buildBeautifyCoverPrompt({ filePath, themeTone, userGuidance, imageModel }), {
      agentId,
      cwd: path.dirname(filePath),
      persist: activityDir,
      activityType: "beautify",
      toolFilter: "*",
      ...(extraCustomTools.length ? { extraCustomTools } : {}),
      onSessionReady: (sessionPath) => {
        if (!sessionPath) return;
        const updated = store.update(activityId, { sessionFile: path.basename(sessionPath) });
        if (updated) emitActivityUpdate(updated, sessionPath);
      },
    }).then((result) => {
      const error = result?.error || (Array.isArray(result?.toolErrors) && result.toolErrors.length ? result.toolErrors.join("; ") : null);
      const updated = store.update(activityId, {
        status: error ? "error" : "done",
        finishedAt: Date.now(),
        summary: error
          ? `Cover 生成失败：${error}`
          : `已应用 ${path.basename(filePath)} 的 cover`,
        ...(result?.sessionPath ? { sessionFile: path.basename(result.sessionPath) } : {}),
      });
      if (updated) emitActivityUpdate(updated, result?.sessionPath || null);
    }).catch((err) => {
      const updated = store.update(activityId, {
        status: "error",
        finishedAt: Date.now(),
        summary: `Cover 生成失败：${err?.message || err}`,
      });
      if (updated) emitActivityUpdate(updated);
    });

    return c.json({ ok: true, activity });
  });

  /** 活动列表（合并所有 agent） */
  route.get("/desk/activities", async (c) => {
    const allActivities = [];
    const now = Date.now();
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      emitActivityUpdates(store?.reconcileOverdueRunning?.({ now }));
      const items = store?.list() || [];
      for (const a of items) {
        allActivities.push({
          ...a,
          agentId: a.agentId || ag.id,
          agentName: a.agentName || ag.name,
        });
      }
    }
    // 按 startedAt 倒序
    allActivities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return c.json({ activities: allActivities });
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  route.get("/desk/activities/:id/session", async (c) => {
    const id = c.req.param("id");
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return deskRouteError(c, "activity_not_found", "activity not found", 404);
    if (!entry.sessionFile) return deskRouteError(c, "activity_session_unavailable", "no session file", 404);

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return deskRouteError(c, "activity_session_missing", "session file missing", 404);

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg) continue;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === "text" && b.text).map(b => b.text).join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return c.json({
        activity: {
          id: entry.id,
          type: entry.type,
          label: entry.label || null,
          agentId: entry.agentId || foundAgentId,
          agentName: entry.agentName || engine.getAgent(foundAgentId)?.agentName || foundAgentId,
          summary: entry.summary,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        },
        messages,
      });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  route.post("/desk/activities/:id/promote", async (c) => {
    const id = c.req.param("id");
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    const newPath = engine.promoteActivitySession(entry.sessionFile, foundAgentId);
    if (!newPath) return c.json({ error: "promote failed" });

    // 从 ActivityStore 移除已升格的条目
    const store = engine.getActivityStore(foundAgentId);
    store?.remove(id);

    return c.json({ ok: true, sessionPath: newPath, agentId: foundAgentId });
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  route.post("/desk/activities/summarize", async (c) => {
    const body = await safeJson(c);
    const { id } = body;
    if (!id) return c.json({ error: "id required" });
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return c.json({ summary: summary || null });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** DevTools 日志（历史） */
  route.get("/desk/logs", async (c) => {
    return c.json({ logs: engine.getDevLogs() });
  });

  /** 手动触发心跳巡检（调试用） */
  route.post("/desk/heartbeat", async (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ error: "agentId is required" }, 400);
    const hb = hub?.scheduler?.getHeartbeat(agentId);
    if (!hb) return deskRouteError(c, "heartbeat_unavailable", "Heartbeat not initialized", 503);
    hb.triggerNow();
    return c.json({ ok: true, message: t("error.heartbeatTriggered") });
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  route.get("/desk/cron", async (c) => {
    try {
      const store = getCronStore(engine, c);
      if (!store) return deskRouteError(c, "cron_store_unavailable", "Desk not initialized", 503);
      return c.json({ jobs: store.listJobs() });
    } catch (err) { return deskRouteError(c, "cron_read_failed", err.message, 503); }
  });

  /** Health/history reads are local and never dispatch an executor. */
  route.get("/desk/cron/:id/health", async (c) => {
    try {
      const service = getCronStore(engine, c);
      if (!service) return deskRouteError(c, "cron_store_unavailable", "Desk not initialized", 503);
      const store = service.getRunStore?.() || service;
      const id = c.req.param("id");
      const job = store.listJobs().find(job => job.id === id);
      if (!job) return deskRouteError(c, "cron_not_found", "cron job not found", 404);
      const owner = job.actorAgentId || job.legacyRef?.agentId || engine.currentAgentId;
      if (c.req.query("agentId") && c.req.query("agentId") !== owner) return deskRouteError(c, "cron_owner_mismatch", "cron owner mismatch", 403);
      const running = automationRuns.isRunning(store, id) || hub?.scheduler?.getCronScheduler?.(owner)?.isRunning?.(id) === true;
      return c.json(readAutomationHealth(store, id, { running }));
    } catch (err) { return deskRouteError(c, "cron_health_read_failed", err.message, 503); }
  });

  /** 操作 cron 任务 */
  route.post("/desk/cron", async (c) => {
    const store = getCronStore(engine, c);
    if (!store) return deskRouteError(c, "cron_store_unavailable", "Desk not initialized", 503);

    const body = await safeJson(c);
    const { action, ...params } = body;

    switch (action) {
      case "add": {
        const type = params.scheduleType || params.type;
        const executor = normalizeRouteExecutor(params.executor);
        try {
          validateRouteExecutor(executor);
        } catch (err) {
          return c.json({ error: err.message }, 400);
        }
        const hasPrompt = typeof params.prompt === "string" && params.prompt.trim();
        const enabled = params.enabled !== false;
        const requiresPrompt = enabled && (!executor || executor.kind === "agent_session");
        if (!type || !params.schedule || (requiresPrompt && !hasPrompt)) {
          return c.json({ error: "scheduleType, schedule, prompt required" }, 400);
        }
        const VALID_TYPES = new Set(["at", "every", "cron"]);
        if (!VALID_TYPES.has(type)) {
          return c.json({ error: `Invalid scheduleType: ${type}. Must be at/every/cron.` }, 400);
        }
        if (type === "every") {
          const minutes = parseInt(params.schedule, 10);
          if (isNaN(minutes) || minutes <= 0) {
            return c.json({ error: "every schedule must be a positive number (minutes)" }, 400);
          }
          params.schedule = minutes * 60_000;
        }
        let job;
        try {
          let actorAgentId = typeof params.actorAgentId === "string" && params.actorAgentId.trim()
            ? params.actorAgentId.trim()
            : null;
          let executionContextInput = params.executionContext && typeof params.executionContext === "object" && !Array.isArray(params.executionContext)
            ? params.executionContext
            : null;
          if (!actorAgentId || !executionContextInput) {
            let fallbackAgent = null;
            try {
              fallbackAgent = resolveAgent(engine, c);
            } catch {}
            actorAgentId = actorAgentId || fallbackAgent?.id || null;
            if (!executionContextInput && fallbackAgent) {
              const cwd = defaultDeskDir(engine) || null;
              executionContextInput = {
                kind: "api_request",
                cwd,
                workspaceFolders: cwd ? [cwd] : [],
                sourceSessionPath: null,
                createdByAgentId: actorAgentId,
              };
            }
          }
          if (!actorAgentId || !executionContextInput) {
            return c.json({ error: "actorAgentId and executionContext required" }, 400);
          }
          if (typeof engine.getAgent === "function" && !engine.getAgent(actorAgentId)) {
            return c.json({ error: `agent not found: ${actorAgentId}` }, 404);
          }
          job = store.addJob({
            type,
            schedule: params.schedule,
            timezone: params.timezone,
            misfirePolicy: params.misfirePolicy,
            prompt: hasPrompt ? params.prompt : "",
            label: params.label,
            model: params.model,
            actorAgentId,
            executionContext: normalizeRouteExecutionContext(executionContextInput, actorAgentId, engine),
            executor,
            createdBy: normalizeRouteCreatedBy(params.createdBy, actorAgentId),
            enabled,
          });
        } catch (err) {
          return c.json({ error: err.message }, 400);
        }
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "remove": {
        if (!params.id) return c.json({ error: "id required" });
        const ok = store.removeJob(params.id);
        if (!ok) return c.json({ error: "not found" });
        return c.json({ ok: true, jobs: store.listJobs() });
      }

      case "toggle": {
        if (!params.id) return c.json({ error: "id required" });
        const job = store.toggleJob(params.id);
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "update": {
        if (!params.id) return c.json({ error: "id required" });
        const { id, ...fields } = params;
        const existingJob = store.getJob(id);
        if (fields.schedule !== undefined) {
          const nextType = fields.type || existingJob?.type;
          if (nextType === "every") {
            const minutes = parseInt(fields.schedule, 10);
            if (!isNaN(minutes) && minutes > 0) {
              fields.schedule = minutes * 60_000;
            }
          }
        }
        let job;
        try {
          job = store.updateJob(id, fields);
        } catch (err) {
          return c.json({ error: err.message }, 400);
        }
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "run-now": {
        if (!params.id || typeof params.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(params.requestId)) {
          return c.json({ error: "id and valid requestId required" }, 400);
        }
        if (!hub?.scheduler?.runAgentCronNow) return c.json({ error: "scheduler unavailable" }, 503);
        try {
          const job = store.listJobs().find(job => job.id === params.id);
          if (!job) return c.json({ error: "cron job not found" }, 404);
          const agentId = job.actorAgentId || job.legacyRef?.agentId || c.req.query("agentId") || engine.currentAgentId || engine.agent?.id;
          if (!agentId) return c.json({ error: "agentId required" }, 400);
          if (c.req.query("agentId") && c.req.query("agentId") !== agentId) return c.json({ error: "cron owner mismatch" }, 403);
          if (!job.prompt?.trim()) return c.json({ error: "saved prompt required" }, 400);
          validateRouteExecutor(normalizeRouteExecutor(job.executor));
          const running = hub.scheduler.getCronScheduler?.(agentId)?.isRunning?.(params.id) === true;
          const runStore = store.getRunStore?.() || store;
          const result = automationRuns.start(runStore, params.id, params.requestId,
            () => hub.scheduler.runAgentCronNow(agentId, params.id, { requestId: params.requestId }),
            { running, reviewedRunKey: params.reviewedRunKey });
          return c.json({ ok: true, ...result }, result.duplicate ? 200 : 202);
        } catch (err) {
          return c.json({ error: err.message }, /running|review/.test(err.message) ? 409 : 503);
        }
      }

      default:
        return deskRouteError(c, "unknown_cron_action", `unknown action: ${action}`, 400);
    }
  });

  // ════════════════════════════
  //  工作空间文件（直接使用 cwd）
  // ════════════════════════════

  /** 扫描工作空间下的项目级技能 */
  route.get("/desk/skills", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ skills: [] });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ skills: [] });

    const results = [];
    for (const { sub, label } of WORKSPACE_SKILL_DIRS) {
      const skillsDir = path.join(dir, sub);
      if (!fs.existsSync(skillsDir)) continue;
      try {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const meta = parseSkillMetadata(content, entry.name);
            results.push({
              name: meta.name,
              description: meta.description,
              source: label,
              dirPath: skillsDir,
              filePath: skillFile,
              baseDir: path.join(skillsDir, entry.name),
            });
          } catch {
            // Ignore malformed workspace skill metadata entries.
          }
        }
      } catch {
        // Ignore unreadable workspace skill source directories.
      }
    }
    return c.json({ skills: results });
  });

  /**
   * 拖拽安装项目技能
   * 接收文件路径，自动创建 .agents/skills/ 并安装
   * 支持文件夹（直接复制）和 .zip/.skill（解压）
   */
  route.post("/desk/install-skill", async (c) => {
    const body = await safeJson(c);
    const { filePath, dir } = body;
    let uploadedSource = null;
    const agentId = body.agentId || null;
    const cwd = dir || defaultDeskDir(engine);
    if (!cwd) {
      return c.json({ error: "active workspace required" }, 400);
    }
    try {
      uploadedSource = filePath ? null : materializeUploadedSkillPackage(engine, body);
    } catch (err) {
      return c.json({ error: err.message }, err.status || 400);
    }
    const sourcePath = filePath || uploadedSource?.sourcePath;
    if (!sourcePath) {
      return c.json({ error: "filePath or file.contentBase64 required" }, 400);
    }
    if (dir && !isApprovedDir(cwd, engine, { agentId })) {
      uploadedSource?.cleanup?.();
      return c.json({ error: "workspace is not approved" }, 403);
    }

    try {
      const skillsDir = path.join(cwd, ".agents", "skills");

      // 确保 .agents/skills/ 存在
      fs.mkdirSync(skillsDir, { recursive: true });

      // macOS: 隐藏 .agents 目录（chflags hidden）
      if (process.platform === "darwin") {
        const agentsDir = path.join(cwd, ".agents");
        try { execFileSync("chflags", ["hidden", agentsDir]); } catch { /* best effort macOS Finder hint */ }
      }

      const installed = await installSkillPackageFromPath({
        sourcePath,
        installDir: skillsDir,
        owner: "workspace",
      });
      if (realPath(cwd) === realPath(engine.deskCwd)) {
        await engine.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: true, force: true });
      }
      return c.json({
        ok: true,
        name: installed.name,
        installedSkillSource: installed.installedSkillSource,
      });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    } finally {
      uploadedSource?.cleanup?.();
    }
  });

  /** 删除项目技能 */
  route.post("/desk/delete-skill", async (c) => {
    const body = await safeJson(c);
    const { skillDir } = body;
    if (!skillDir) {
      return c.json({ error: "skillDir is required" }, 400);
    }
    // 安全检查：必须在当前工作区的已知技能目录下
    const cwd = defaultDeskDir(engine);
    if (!cwd) {
      return c.json({ error: "No active workspace" }, 400);
    }
    const ALLOWED_SKILL_SUBS = WORKSPACE_SKILL_DIRS.map(({ sub }) => sub);
    const allowed = ALLOWED_SKILL_SUBS.some(sub =>
      isInsidePath(skillDir, path.join(cwd, sub))
    );
    if (!allowed) {
      return c.json({ error: "Only skills in current workspace skill directories can be deleted" }, 403);
    }
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      if (realPath(cwd) === realPath(engine.deskCwd)) {
        await engine.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** 工作空间路径 */
  route.get("/desk/path", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ path: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(dir, { recursive: true });
    return c.json({ path: dir });
  });

  /** */
  route.get("/desk/files", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ files: [], subdir: "", basePath: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    return c.json({ files: await listWorkspaceFiles(target), subdir: subdir || "", basePath: dir });
  });

  route.get("/desk/search-files", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ results: [], basePath: null, query: c.req.query("q") || "" });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const query = c.req.query("q") || "";
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, WORKSPACE_SEARCH_LIMIT)
      : WORKSPACE_SEARCH_LIMIT;
    let stat = null;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      return c.json({ results: [], basePath: dir, query });
    }
    if (!stat.isDirectory()) return c.json({ error: t("error.pathNotFound") });
    return c.json({ results: await searchWorkspaceFiles(dir, query, { limit }), basePath: dir, query });
  });

  /** 读取指定目录的 jian.md */
  route.get("/desk/jian", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ content: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");
    if (!fs.existsSync(jianPath)) return c.json({ content: null });
    try {
      return c.json({ content: fs.readFileSync(jianPath, "utf-8") });
    } catch {
      return c.json({ content: null });
    }
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  route.post("/desk/jian", async (c) => {
    const body = await safeJson(c);
    const agentId = body.agentId || null;
    const dir = body.dir ? body.dir : defaultDeskDir(engine);
    if (!dir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const { subdir, content } = body;
    const sub = subdir || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");

    try {
      if (content === null || content === undefined || content.trim() === "") {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return c.json({ ok: true, content: null });
      }
      // 确保目录存在
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(jianPath, content, "utf-8");
      return c.json({ ok: true, content });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 工作空间文件操作（支持 subdir + dir override） */
  route.post("/desk/files", async (c) => {
    const body = await safeJson(c);
    const agentId = body.agentId || null;
    const baseDir = body.dir || defaultDeskDir(engine);
    if (!baseDir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(baseDir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName, sourceName } = body;

    // 解析子目录
    const isValidSubdir = (value) => {
      const subdir = value || "";
      return !(subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."));
    };
    const subdirToDir = (value) => {
      const subdir = value || "";
      if (!isValidSubdir(subdir)) return null;
      const target = subdir ? path.join(baseDir, subdir) : baseDir;
      return isInsidePath(target, baseDir) ? target : null;
    };
    const subdirStr = sub || "";
    const dir = subdirToDir(subdirStr);
    if (!dir) return c.json({ error: "invalid path" });

    switch (action) {
      case "upload": {
        if (!isLocalOwnerPrincipal(readAuthPrincipal(c))) {
          return c.json({ error: "upload by absolute path requires local owner" }, 403);
        }
        if (!Array.isArray(paths) || paths.length === 0) {
          return c.json({ error: "paths required" });
        }
        const results = [];
        for (const srcPath of paths) {
          try {
            if (!path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) {
              results.push({ src: srcPath, error: "invalid path" });
              continue;
            }
            if (isSensitivePath(srcPath, engine.codiaHome)) {
              results.push({ src: srcPath, error: "sensitive path blocked" });
              continue;
            }
            const fname = path.basename(srcPath);
            const dest = path.join(dir, fname);
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
              fs.cpSync(srcPath, dest, { recursive: true });
            } else {
              fs.copyFileSync(srcPath, dest);
            }
            results.push({ src: srcPath, name: fname });
          } catch (err) {
            results.push({ src: srcPath, error: err.message });
          }
        }
        return c.json({ ok: true, results, files: await listWorkspaceFiles(dir) });
      }

      case "create": {
        if (!name || content === undefined) {
          return c.json({ error: "name and content required" });
        }
        if (!isPlainEntryName(name)) return c.json({ error: "invalid name" });
        const createTarget = path.join(dir, name);
        if (!isInsidePath(createTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(createTarget)) return c.json({ error: "target already exists" });
        fs.writeFileSync(createTarget, content, "utf-8");
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "createMindmap": {
        if (!name) return c.json({ error: "name required" });
        const safeName = sanitizeXmindName(name);
        const createTarget = path.join(dir, safeName);
        if (!isInsidePath(createTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(createTarget)) return c.json({ error: "target already exists" });
        fs.writeFileSync(createTarget, buildXmindWorkbook(body.title || safeName.replace(/\.xmind$/i, "")));
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "createMindmapFromDocument": {
        if (!sourceName) return c.json({ error: "sourceName required" });
        const sourceBaseName = path.basename(sourceName);
        const sourcePath = path.join(dir, sourceBaseName);
        if (!isInsidePath(sourcePath, dir)) return c.json({ error: "invalid sourceName" });
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return c.json({ error: "source not found" });

        const safeName = uniqueFileName(
          dir,
          sanitizeXmindName(name || sourceBaseName),
        );
        const createTarget = path.join(dir, safeName);
        if (!isInsidePath(createTarget, dir)) return c.json({ error: "invalid name" });

        const title = sourceBaseName.replace(/\.[^.]+$/i, "") || safeName.replace(/\.xmind$/i, "");
        const text = await extractDocumentTextForMindmap(sourcePath);
        const rootTopic = await generateMindmapFromDocument(engine, title, text, { callText });
        fs.writeFileSync(createTarget, buildXmindWorkbook(rootTopic.title || title, rootTopic.children || []));
        return c.json({ ok: true, name: safeName, files: await listWorkspaceFiles(dir) });
      }

      case "mkdir": {
        if (!name) return c.json({ error: "name required" });
        if (!isPlainEntryName(name)) return c.json({ error: "invalid name" });
        const mkTarget = path.join(dir, name);
        if (!isInsidePath(mkTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(mkTarget)) return c.json({ error: "already exists" });
        fs.mkdirSync(mkTarget, { recursive: true });
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "rename": {
        if (!oldName || !newName) return c.json({ error: "oldName and newName required" });
        if (!isPlainEntryName(oldName) || !isPlainEntryName(newName)) return c.json({ error: "invalid name" });
        const src = path.join(dir, oldName);
        const dest = path.join(dir, newName);
        if (!isInsidePath(src, dir) || !isInsidePath(dest, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(src)) return c.json({ error: "not found" });
        if (fs.existsSync(dest)) return c.json({ error: "target already exists" });
        fs.renameSync(src, dest);
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "move": {
        const names = body.names;
        const destFolder = body.destFolder;
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return c.json({ error: "names[] and destFolder required" });
        }
        if (names.includes(destFolder)) {
          return c.json({ error: "cannot move folder into itself" });
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return c.json({ error: "invalid destFolder" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destFolder is not a directory" });
        }
        const results = [];
        for (const n of names) {
          const src = path.join(dir, path.basename(n));
          const dest = path.join(destDir, path.basename(n));
          if (!isInsidePath(src, dir)) { results.push({ name: n, error: "invalid name" }); continue; }
          if (!fs.existsSync(src)) { results.push({ name: n, error: "not found" }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: n, error: "target already exists" }); continue; }
          try {
            fs.renameSync(src, dest);
            results.push({ name: n, ok: true });
          } catch (err) {
            results.push({ name: n, error: err.message });
          }
        }
        return c.json({ ok: true, results, files: await listWorkspaceFiles(dir) });
      }

      case "movePaths": {
        const items = body.items;
        const destSubdir = body.destSubdir || "";
        const currentSubdir = body.currentSubdir || "";
        if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items[] required" });
        const destDir = subdirToDir(destSubdir);
        if (!destDir) return c.json({ error: "invalid destSubdir" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destSubdir is not a directory" });
        }

        const affectedSubdirs = new Set([destSubdir, currentSubdir]);
        const results = [];
        for (const item of items) {
          const sourceSubdir = item && typeof item.sourceSubdir === "string" ? item.sourceSubdir : "";
          const itemName = item && typeof item.name === "string" ? path.basename(item.name) : "";
          if (!itemName) { results.push({ name: item?.name, error: "invalid name" }); continue; }
          const sourceDir = subdirToDir(sourceSubdir);
          if (!sourceDir) { results.push({ name: itemName, error: "invalid sourceSubdir" }); continue; }

          const src = path.join(sourceDir, itemName);
          const dest = path.join(destDir, itemName);
          if (!isInsidePath(src, sourceDir) || !isInsidePath(dest, destDir)) {
            results.push({ name: itemName, error: "invalid path" });
            continue;
          }
          if (!fs.existsSync(src)) { results.push({ name: itemName, error: "not found" }); continue; }
          if (src === dest) { results.push({ name: itemName, ok: true, skipped: true }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: itemName, error: "target already exists" }); continue; }

          const sourceRel = sourceSubdir ? `${sourceSubdir}/${itemName}` : itemName;
          if (fs.statSync(src).isDirectory() && (destSubdir === sourceRel || destSubdir.startsWith(`${sourceRel}/`))) {
            results.push({ name: itemName, error: "cannot move folder into itself" });
            continue;
          }

          try {
            fs.renameSync(src, dest);
            affectedSubdirs.add(sourceSubdir);
            affectedSubdirs.add(destSubdir);
            results.push({ name: itemName, ok: true });
          } catch (err) {
            results.push({ name: itemName, error: err.message });
          }
        }

        const filesByPath = {};
        for (const subdir of affectedSubdirs) {
          if (!isValidSubdir(subdir)) continue;
          const targetDir = subdirToDir(subdir);
          if (targetDir && fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
            filesByPath[subdir] = await listWorkspaceFiles(targetDir);
          }
        }
        return c.json({ ok: true, results, filesByPath, files: await listWorkspaceFiles(dir) });
      }

      case "remove": {
        if (!name) return c.json({ error: "name required" });
        const rmTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(rmTarget, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(rmTarget)) return c.json({ error: "not found" });
        fs.rmSync(rmTarget, { recursive: true, force: true });
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      default:
        return c.json({ error: `unknown action: ${action}` });
    }
  });

  return route;
}
