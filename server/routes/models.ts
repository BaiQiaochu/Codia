// @ts-nocheck
/**
 * 模型管理 REST 路由
 */
import { Hono } from "hono";
import path from "path";
import { isInvalidJsonBodyError, routeError, strictJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { modelRefEquals, parseModelRef } from "../../shared/model-ref.ts";
import { lookupKnown } from "../../shared/known-models.ts";
import { resolveModelTypeFromModelId } from "../../shared/model-type-inference.ts";
import {
  getReasoningProfile,
  getThinkingFormat,
  MODEL_IMAGE_TRANSPORTS,
  MODEL_VIDEO_TRANSPORTS,
  modelSupportsVideoInput,
  resolveModelImageInputTransport,
  resolveModelInputModalities,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.ts";
import { callText } from "../../core/llm-client.ts";
import { modelSupportsImage } from "../../core/message-sanitizer.ts";
import { getModelThinkingLevels, modelSupportsXhigh, resolveModelDefaultThinkingLevel } from "../../core/session-thinking-level.ts";

function resolveModelName(id, sdkName, overrides, provider) {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  const known = lookupKnown(provider, id);
  if (known?.name) return known.name;
  return sdkName || id;
}

function modelInput(model) {
  return resolveModelInputModalities(model);
}

function modelKind(model) {
  const known = lookupKnown(model?.provider, model?.id);
  return resolveModelTypeFromModelId(model?.id, model?.provider, model?.type, known?.type);
}

function isChatModel(model) {
  return modelKind(model) === "chat";
}

function isVisionCandidateModel(model) {
  return modelSupportsImage(model);
}

function findAvailableModel(engine, modelId, provider) {
  return (engine.availableModels || []).find((m) => m.id === modelId && m.provider === provider);
}

function endpointKindForApi(api) {
  if (api === "anthropic-messages") return "anthropic-messages";
  if (api === "openai-responses" || api === "openai-codex-responses") return "responses";
  if (api === "google-generative-ai") return "gemini-generate-content";
  return "chat-completions";
}

function baseHostFromUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const text = raw.trim();
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${text}`).hostname.toLowerCase();
    } catch {
      return text.toLowerCase().split(/[/?#]/)[0].replace(/:\d+$/, "");
    }
  }
}

function routingRef(ref) {
  const parsed = parseModelRef(ref);
  if (!parsed?.id || !parsed?.provider) return null;
  return { id: parsed.id, provider: parsed.provider };
}

function routingRefText(ref) {
  if (!ref?.id || !ref?.provider) return "";
  return `${ref.provider}/${ref.id}`;
}

function collectRoutingRefs(engine) {
  const refs = [];
  const active = engine.activeSessionModel || engine.currentModel;
  const activeRef = routingRef(active);
  if (activeRef) refs.push({ slot: "active", ref: activeRef, fallbackModel: active, source: "active session model" });

  const shared = typeof engine.getSharedModels === "function" ? (engine.getSharedModels() || {}) : {};
  for (const slot of ["utility", "utility_large", "vision"]) {
    const ref = routingRef(shared[slot]);
    if (ref) refs.push({ slot, ref, fallbackModel: null, source: "shared model preferences" });
  }
  return refs;
}

function serializeRouting(engine, slot, ref, fallbackModel = null, source = "model preferences") {
  try {
    if (typeof engine.resolveModelWithCredentials !== "function") {
      throw new Error("model credential resolver unavailable");
    }
    const resolved = engine.resolveModelWithCredentials(ref);
    const model = {
      ...(fallbackModel || {}),
      ...(resolved.model || {}),
      id: resolved.model?.id || fallbackModel?.id || ref.id,
      provider: resolved.model?.provider || resolved.provider || fallbackModel?.provider || ref.provider,
      api: resolved.model?.api || resolved.api,
      baseUrl: resolved.model?.baseUrl || resolved.model?.base_url || resolved.base_url,
    };
    const imageTransport = resolveModelImageInputTransport(model);
    const videoTransport = resolveModelVideoInputTransport(model);
    const warnings = [];
    const candidates = [];
    if (slot === "vision" && !modelSupportsImage(model)) {
      warnings.push("missing_capability:image");
      candidates.push({
        slot,
        ref: routingRefText(ref),
        modelId: model.id,
        providerId: model.provider,
        status: "rejected",
        reason: "missing_capability",
        requiredCapability: "image",
      });
    }
    if (imageTransport === MODEL_IMAGE_TRANSPORTS.UNSUPPORTED) warnings.push("image_transport_unsupported");
    if (videoTransport === MODEL_VIDEO_TRANSPORTS.UNSUPPORTED) warnings.push("video_transport_unsupported");
    if (!resolved.base_url) warnings.push("base_url_missing");
    const trace = [
      `slot ${slot} resolved from ${source}`,
      "credentials resolved without exposing secrets",
      `endpoint kind selected from api ${resolved.api || "unknown"}`,
      `input modalities resolved as ${(resolveModelInputModalities(model) || ["text"]).join("/")}`,
    ];
    const thinkingFormat = getThinkingFormat(model);
    const reasoningProfile = getReasoningProfile(model);
    if (thinkingFormat) trace.push("thinking format selected from model capabilities");
    if (reasoningProfile) trace.push("reasoning profile selected from model capabilities");
    if (warnings.length > 0) trace.push(`warnings: ${warnings.join(", ")}`);

    return {
      slot,
      status: warnings.length > 0 ? "warn" : "ok",
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
      api: resolved.api || "",
      endpointKind: endpointKindForApi(resolved.api),
      baseHost: baseHostFromUrl(resolved.base_url),
      input: resolveModelInputModalities(model),
      imageTransport,
      videoTransport,
      thinkingFormat,
      reasoningProfile,
      roleNormalization: true,
      outputBudgetNormalization: true,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? model.maxOutputTokens ?? null,
      warnings,
      candidates,
      trace,
    };
  } catch (err) {
    return {
      slot,
      status: "error",
      id: ref.id,
      provider: ref.provider,
      error: err instanceof Error ? err.message : String(err),
      warnings: ["routing_resolution_failed"],
      trace: [
        `slot ${slot} resolved from ${source}`,
        "routing resolution failed before credentials could be validated",
      ],
    };
  }
}

function serializeTraceSelection(slot, selection, tracePayload) {
  const api = selection?.api || "";
  const candidates = Array.isArray(tracePayload?.candidates)
    ? tracePayload.candidates.filter((candidate) => candidate?.slot === slot)
    : [];
  const warnings = Array.isArray(tracePayload?.warnings) ? tracePayload.warnings.filter(Boolean) : [];
  return {
    slot,
    status: warnings.length > 0 ? "warn" : "ok",
    id: selection?.modelId || "",
    name: selection?.modelId || "",
    provider: selection?.providerId || "",
    api,
    endpointKind: endpointKindForApi(api),
    baseHost: selection?.baseHost || "",
    input: ["text"],
    imageTransport: MODEL_IMAGE_TRANSPORTS.NONE,
    videoTransport: MODEL_VIDEO_TRANSPORTS.NONE,
    thinkingFormat: null,
    reasoningProfile: null,
    roleNormalization: true,
    outputBudgetNormalization: true,
    contextWindow: null,
    maxTokens: null,
    warnings,
    candidates,
    fallbackPath: Array.isArray(tracePayload?.fallbackPath) ? tracePayload.fallbackPath : [],
    trace: Array.isArray(tracePayload?.trace) ? tracePayload.trace.filter(Boolean) : [],
  };
}

function appendUtilityTraceRoutes(engine, routes) {
  if (typeof engine.traceUtilityConfig !== "function") return routes;
  try {
    const trace = engine.traceUtilityConfig();
    const selected = trace?.selected || {};
    for (const slot of ["utility", "utility_large"]) {
      if (!selected[slot] || routes.some((route) => route.slot === slot)) continue;
      routes.push(serializeTraceSelection(slot, selected[slot], trace));
    }
  } catch {
    // Routing diagnostics must not break the settings diagnostics page.
  }
  return routes;
}

function serializeModel(model, overrides, currentRef) {
  return {
    id: model.id,
    name: resolveModelName(model.id, model.name, overrides, model.provider),
    provider: model.provider,
    type: modelKind(model),
    isCurrent: currentRef ? modelRefEquals(model, currentRef) : false,
    input: modelInput(model),
    image: modelSupportsImage(model),
    vision: modelSupportsImage(model),
    video: modelSupportsVideoInput(model),
    reasoning: model.reasoning,
    thinkingLevels: getModelThinkingLevels(model),
    defaultThinkingLevel: resolveModelDefaultThinkingLevel(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(modelSupportsXhigh(model) ? { xhigh: true } : {}),
  };
}

function sessionIdFromPath(sessionPath: any) {
  return path.basename(sessionPath || "").replace(/\.(jsonl|json)$/i, "");
}

async function resolveSessionPathRef(engine: any, body: any = {}) {
  const directPath = body.sessionPath || body.path;
  if (typeof directPath === "string" && directPath.trim()) {
    return { sessionPath: directPath };
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return { error: t("error.missingParam", { param: "sessionPath or sessionId" }), status: 400 };
  }

  const sessions = typeof engine.listSessions === "function" ? await engine.listSessions() : [];
  const match = sessions.find((session) => {
    return session?.id === sessionId || sessionIdFromPath(session?.path) === sessionId;
  });
  if (!match?.path) return { error: "session not found", status: 404 };
  return { sessionPath: match.path };
}

function parseHealthModelRef(body) {
  const parsed = parseModelRef(body?.model ?? body?.modelId);
  if (!parsed?.id) return { error: "modelId required" };

  const bodyProvider = typeof body.provider === "string" ? body.provider.trim() : "";
  if (parsed.provider && bodyProvider && parsed.provider !== bodyProvider) {
    return { error: "provider mismatch" };
  }

  const provider = bodyProvider || parsed.provider;
  if (!provider) return { error: "provider required" };
  return { id: parsed.id, provider };
}

function serializeAuxiliaryVisionModel(model, fallbackRef = null) {
  const parsedFallback = parseModelRef(fallbackRef);
  const id = typeof model?.id === "string" && model.id.trim()
    ? model.id.trim()
    : parsedFallback?.id;
  const provider = typeof model?.provider === "string" && model.provider.trim()
    ? model.provider.trim()
    : parsedFallback?.provider;
  if (!id || !provider) return null;
  return { id, provider };
}

function buildAuxiliaryVisionStatus(engine) {
  const shared = engine.getSharedModels?.() || {};
  const enabled = shared.vision_enabled === true;
  const configured = !!shared.vision;
  const configuredModel = serializeAuxiliaryVisionModel(null, shared.vision);

  if (!enabled) {
    return {
      enabled: false,
      configured,
      available: false,
      unavailableReason: "disabled",
      model: configuredModel,
    };
  }

  if (!configured) {
    return {
      enabled: true,
      configured: false,
      available: false,
      unavailableReason: "not_configured",
      model: null,
    };
  }

  let resolved = null;
  try {
    resolved = engine.resolveModelWithCredentials?.(shared.vision) || null;
  } catch {
    return {
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_not_found",
      model: configuredModel,
    };
  }

  const model = serializeAuxiliaryVisionModel(resolved?.model, shared.vision);
  if (!resolved?.model) {
    return {
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_not_found",
      model,
    };
  }

  if (!modelSupportsImage(resolved.model)) {
    return {
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_without_image_input",
      model,
    };
  }

  return {
    enabled: true,
    configured: true,
    available: true,
    unavailableReason: null,
    model,
  };
}

export function createModelsRoute(engine: any) {
  const route = new Hono<any>();

  route.get("/models", async (c) => {
    try {
      const overrides = engine.config?.models?.overrides;
      const cur = engine.currentModel;
      const activeModel = engine.activeSessionModel;
      const include = c.req.query("include");
      const filterModels = include === "vision" ? isVisionCandidateModel : isChatModel;
      const pwaSession = c.get("pwaSession");
      const list = pwaSession
        ? (cur && filterModels(cur) ? [cur] : [])
        : engine.availableModels.filter(filterModels);
      const models = list.map((m) => serializeModel(m, overrides, cur));
      return c.json({
        models,
        current: cur?.id || null,
        activeModel: activeModel ? { id: activeModel.id, provider: activeModel.provider } : null,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/models/auxiliary-vision", async (c) => {
    try {
      return c.json({ auxiliaryVision: buildAuxiliaryVisionStatus(engine) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/models/routing", async (c) => {
    try {
      const routes = collectRoutingRefs(engine)
        .map(({ slot, ref, fallbackModel, source }) => serializeRouting(engine, slot, ref, fallbackModel, source));
      appendUtilityTraceRoutes(engine, routes);
      return c.json({ ok: true, routes });
    } catch (err) {
      return c.json({ ok: false, error: err.message, routes: [] }, 500);
    }
  });

  route.post("/models/health", async (c) => {
    try {
      const body = await strictJson(c);
      const modelRef = parseHealthModelRef(body);
      if (modelRef.error) return c.json({ error: modelRef.error }, 400);

      const resolved = engine.resolveModelWithCredentials(modelRef);

      if (resolved.api === "openai-codex-responses") {
        return c.json({ ok: true, status: 0, provider: resolved.provider, skipped: t("error.codexNoHealthCheck") });
      }

      await callText({
        api: resolved.api,
        apiKey: resolved.api_key,
        baseUrl: resolved.base_url,
        model: resolved.model,
        messages: [{ role: "user", content: "Reply OK." }],
        maxTokens: 8,
        timeoutMs: 15_000,
        usageLedger: engine.usageLedger,
        usageContext: {
          source: {
            subsystem: "utility",
            operation: "model_health_check",
            surface: "settings",
            trigger: "manual",
          },
          attribution: {
            kind: "utility",
            agentId: engine.currentAgentId || null,
          },
        },
      });

      return c.json({ ok: true, status: 200, provider: resolved.provider });
    } catch (err) {
      if (isInvalidJsonBodyError(err)) return routeError(c, err);
      return c.json({ ok: false, error: err.message });
    }
  });

  route.post("/models/set", async (c) => {
    try {
      const body = await strictJson(c);
      const { modelId, provider } = body;
      if (!modelId) {
        return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      }
      if (!provider) {
        return c.json({ error: t("error.missingParam", { param: "provider" }) }, 400);
      }
      const target = findAvailableModel(engine, modelId, provider);
      if (!target) return c.json({ error: t("error.modelNotFound", { id: `${provider}/${modelId}` }) }, 404);
      if (!isChatModel(target)) return c.json({ error: `model ${provider}/${modelId} is not a chat model` }, 400);
      engine.setPendingModel(modelId, provider);
      return c.json({ ok: true, model: engine.currentModel?.name, pendingModel: true });
    } catch (err) {
      return routeError(c, err);
    }
  });

  route.post("/models/switch", async (c) => {
    try {
      const body = await strictJson(c);
      const { modelId, provider } = body;
      const sessionRef = await resolveSessionPathRef(engine, body);
      if (!sessionRef.sessionPath) return c.json({ error: sessionRef.error }, (sessionRef.status || 400) as any);
      const sessionPath = sessionRef.sessionPath;
      if (!modelId) return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      if (!provider) return c.json({ error: t("error.missingParam", { param: "provider" }) }, 400);

      if (engine.isSessionStreaming(sessionPath)) {
        return c.json({ error: "cannot switch model while streaming" }, 409);
      }

      const target = findAvailableModel(engine, modelId, provider);
      if (!target) return c.json({ error: t("error.modelNotFound", { id: `${provider}/${modelId}` }) }, 404);
      if (!isChatModel(target)) return c.json({ error: `model ${provider}/${modelId} is not a chat model` }, 400);

      const result = await engine.switchSessionModel(sessionPath, modelId, provider);

      const session = engine.getSessionByPath(sessionPath);
      const sessionModel = session?.model;
      const overrides = engine.config?.models?.overrides;
      const modelInfo = sessionModel ? {
        id: sessionModel.id,
        name: resolveModelName(sessionModel.id, sessionModel.name, overrides, sessionModel.provider),
        provider: sessionModel.provider,
        input: modelInput(sessionModel),
        video: modelSupportsVideoInput(sessionModel),
        reasoning: sessionModel.reasoning,
        thinkingLevels: getModelThinkingLevels(sessionModel),
        defaultThinkingLevel: resolveModelDefaultThinkingLevel(sessionModel),
        contextWindow: sessionModel.contextWindow,
        ...(modelSupportsXhigh(sessionModel) ? { xhigh: true } : {}),
      } : null;

      return c.json({ ok: true, model: modelInfo, adaptations: result.adaptations, thinkingLevel: result.thinkingLevel });
    } catch (err) {
      return routeError(c, err);
    }
  });

  return route;
}
