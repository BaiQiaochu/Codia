// @ts-nocheck
import path from "node:path";
import { resolveImageAdapter as resolveLegacyImageAdapter } from "./resolve-image-adapter.ts";

export function createTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function errorMessage(err) {
  return err?.message || String(err || "unknown error");
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const TRANSIENT_SUBMIT_MAX_ATTEMPTS = 2;
const TRANSIENT_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504, 522, 523, 524]);

function numericStatus(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function statusFromError(err) {
  if (!err || typeof err !== "object") return null;
  return numericStatus(err.status)
    ?? numericStatus(err.statusCode)
    ?? numericStatus(err.code)
    ?? null;
}

function isTransientSubmitError(err) {
  const status = statusFromError(err);
  if (status != null) return TRANSIENT_HTTP_STATUS.has(status);

  const message = errorMessage(err);
  const explicitStatus = message.match(/\b(?:api\s+error|error\s+code|status)\s*:?\s*(\d{3})\b/i)?.[1];
  if (explicitStatus) {
    const parsed = Number(explicitStatus);
    if (parsed >= 400 && parsed < 500 && !TRANSIENT_HTTP_STATUS.has(parsed)) return false;
    return TRANSIENT_HTTP_STATUS.has(parsed);
  }

  return /\b(ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN)\b/i.test(message) ||
    /\b(fetch failed|socket hang up|timeout|timed out|temporarily unavailable)\b/i.test(message) ||
    /\b(5\d\d|522|523|524)\b/.test(message);
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectReferenceImages(input = {}) {
  const refs = [];
  const seen = new Set();
  const add = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    const ref = String(value).trim();
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  add(input.referenceImages);
  add(input.images);
  add(input.image);
  return refs;
}

function normalizeSizeValue(value) {
  if (value == null || value === "") return null;
  const str = String(value).trim();
  if (!str) return null;
  return /^(2k|4k)$/i.test(str) ? str.toUpperCase() : str;
}

export function normalizeSessionRef(ctx) {
  const rawRef = ctx?.sessionRef && typeof ctx.sessionRef === "object" ? ctx.sessionRef : null;
  const sessionId = textOrNull(ctx?.sessionId) || textOrNull(rawRef?.sessionId);
  const sessionPath =
    textOrNull(ctx?.sessionPath)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const legacySessionPath =
    textOrNull(ctx?.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && sessionPath ? sessionPath : null);
  const sessionRef = sessionId
    ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;
  return { sessionId, sessionPath, sessionRef };
}

export function normalizeSessionPath(ctx) {
  return normalizeSessionRef(ctx).sessionPath;
}

export function normalizeMediaDelivery(input = {}) {
  const delivery = isObject(input.delivery) ? input.delivery : {};
  const mode = String(delivery.mode || input.deliveryMode || "session").trim().toLowerCase();
  return {
    ...delivery,
    mode: mode || "session",
  };
}

export function isResponseDelivery(value = {}) {
  if (!isObject(value)) return false;
  const delivery = isObject(value.delivery) ? value.delivery : value;
  const mode = delivery.mode || value.deliveryMode;
  return String(mode || "").trim().toLowerCase() === "response";
}

export function generatedDirForCtx(ctx) {
  return path.join(ctx.dataDir, "generated");
}

export function createSubmitContext(ctx) {
  return {
    dataDir: ctx.dataDir,
    bus: ctx.bus,
    log: ctx.log,
    generatedDir: generatedDirForCtx(ctx),
    config: ctx.config,
  };
}

export function bridgeDeliveryTarget(ctx) {
  const bridge = ctx?.bridgeContext;
  if (bridge?.isBridgeSession !== true || !bridge.platform || !bridge.chatId) return null;
  return {
    kind: "bridge",
    platform: bridge.platform,
    chatId: bridge.chatId,
    ...(bridge.sessionKey ? { sessionKey: bridge.sessionKey } : {}),
    ...(bridge.agentId ? { agentId: bridge.agentId } : {}),
    ...(bridge.chatType ? { chatType: bridge.chatType } : {}),
  };
}

export function buildImageParams(input) {
  const aspectRatio = input.aspect_ratio || input.aspectRatio || input.ratio || null;
  const size = normalizeSizeValue(input.size || input.resolution);
  const resolution = normalizeSizeValue(input.resolution);
  const referenceImages = collectReferenceImages(input);
  return {
    type: "image",
    prompt: input.prompt,
    ...(input.suggestedFilename && { filename: input.suggestedFilename }),
    ...(input.filename && { filename: input.filename }),
    ...(aspectRatio && { ratio: aspectRatio, aspect_ratio: aspectRatio }),
    ...(resolution && { resolution }),
    ...(size && { size }),
    ...(input.quality && { quality: input.quality }),
    ...(input.model && { model: input.model }),
    ...(referenceImages.length === 1 && { image: referenceImages[0] }),
    ...(referenceImages.length > 1 && { images: referenceImages }),
    ...(input._compatImageArrayAlias && referenceImages.length > 1 && { image: referenceImages }),
    ...(input.options && typeof input.options === "object" && !Array.isArray(input.options) ? input.options : {}),
  };
}

export function imageDeferredMeta({ prompt, deliveryTarget = null } = {}) {
  return mediaDeferredMeta({ prompt, deliveryTarget, kind: "image" });
}

export function mediaDeferredMeta({ prompt, deliveryTarget = null, kind = "image" } = {}) {
  const mediaKind = kind === "video" ? "video" : "image";
  return {
    type: `${mediaKind}-generation`,
    mediaKind,
    deliveryIntent: "ui_only",
    triggerParentTurn: false,
    prompt,
    ...(deliveryTarget ? { deliveryTarget } : {}),
  };
}

function targetFromAdapter(adapter, input, media = {}) {
  if (!adapter) return null;
  return {
    adapter,
    providerId: media.providerId || input.provider || adapter.id,
    modelId: media.modelId || input.model || null,
    model: media.model || null,
    protocolId: media.protocolId || adapter.protocolId || null,
    credentialLaneId: media.credentialLaneId || null,
    credentialProviderId: media.credentialProviderId || media.providerId || input.provider || adapter.id,
  };
}

async function listMediaProviders(submitCtx) {
  try {
    const result = await submitCtx.bus?.request?.("provider:media-providers", { capability: "image_generation" });
    return result?.providers && typeof result.providers === "object" ? result.providers : {};
  } catch {
    return {};
  }
}

async function resolveMediaModel(submitCtx, ref) {
  try {
    const result = await submitCtx.bus?.request?.("provider:resolve-media-model", {
      providerId: ref.providerId,
      modelId: ref.modelId,
      capability: "image_generation",
      ...(ref.credentialLaneId ? { credentialLaneId: ref.credentialLaneId } : {}),
    });
    if (result?.error) return { error: result.error };
    if (!result?.protocolId) return { error: `media model "${ref.providerId}/${ref.modelId}" missing protocolId` };
    return { media: result };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function explicitProviderError(providerId, detail = "") {
  return `Specified image generation provider "${providerId}" is unavailable${detail ? `: ${detail}` : ""}`;
}

function explicitModelError(modelId, detail = "") {
  return `Specified image generation model "${modelId}" is unavailable${detail ? `: ${detail}` : ""}`;
}

async function availableAdapterOrThrow(adapter, submitCtx, providerId) {
  if (!adapter) throw new Error(explicitProviderError(providerId));
  if (typeof adapter.checkAuth === "function") {
    try {
      const auth = await adapter.checkAuth(submitCtx);
      if (auth?.ok === false) {
        throw new Error(auth.message || "credentials unavailable");
      }
    } catch (err) {
      throw new Error(explicitProviderError(providerId, errorMessage(err)));
    }
  }
  return adapter;
}

async function targetFromMediaRef(input, registry, submitCtx, ref, { strict = false } = {}) {
  if (!ref?.providerId) return null;
  let modelId = ref.modelId || null;
  if (!modelId) {
    const providers = await listMediaProviders(submitCtx);
    modelId = providers[ref.providerId]?.models?.[0]?.id || null;
    if (!modelId) {
      if (strict && providers[ref.providerId]) {
        throw new Error(explicitProviderError(ref.providerId, "no image model is configured"));
      }
      return null;
    }
  }

  const { media, error } = await resolveMediaModel(submitCtx, { providerId: ref.providerId, modelId });
  if (!media) {
    if (strict) throw new Error(explicitProviderError(ref.providerId, error || `model ${modelId} not found`));
    return null;
  }
  const adapter = registry.getProtocol?.(media.protocolId) || registry.get(media.providerId);
  if (!adapter) {
    if (strict) throw new Error(explicitProviderError(ref.providerId, `no adapter registered for protocol ${media.protocolId}`));
    return null;
  }
  return targetFromAdapter(adapter, input, media);
}

async function targetFromExplicitProvider(input, registry, submitCtx) {
  const mediaTarget = await targetFromMediaRef(input, registry, submitCtx, {
    providerId: input.provider,
    modelId: input.model || null,
  }, { strict: false });
  if (mediaTarget) return mediaTarget;

  const adapter = await availableAdapterOrThrow(registry.get(input.provider), submitCtx, input.provider);
  return targetFromAdapter(adapter, input, {
    providerId: input.provider,
    modelId: input.model || null,
    credentialProviderId: input.provider,
  });
}

async function targetFromExplicitModel(input, registry, submitCtx) {
  if (!input.model) return null;
  const providers = await listMediaProviders(submitCtx);
  const matches = [];
  for (const provider of Object.values(providers)) {
    const model = provider?.models?.find((item) => item?.id === input.model);
    if (model) matches.push({ providerId: provider.providerId, modelId: model.id });
  }
  if (matches.length === 1) {
    return targetFromMediaRef(input, registry, submitCtx, matches[0], { strict: true });
  }
  if (matches.length > 1) {
    throw new Error(explicitModelError(input.model, "multiple providers expose this model; specify provider too"));
  }
  return null;
}

async function targetFromConfiguredDefault(input, registry, submitCtx) {
  const defaultModel = submitCtx.config?.get?.("defaultImageModel");
  if (!defaultModel?.provider) return null;
  return targetFromMediaRef(input, registry, submitCtx, {
    providerId: defaultModel.provider,
    modelId: defaultModel.id,
  }, { strict: false });
}

async function targetFromFirstAvailableProvider(input, registry, submitCtx) {
  const providers = await listMediaProviders(submitCtx);
  for (const provider of Object.values(providers)) {
    if (provider?.hasCredentials === false) continue;
    const model = provider?.models?.find((item) => registry.getProtocol?.(item.protocolId));
    if (!model) continue;
    const target = await targetFromMediaRef(input, registry, submitCtx, {
      providerId: provider.providerId,
      modelId: model.id,
    });
    if (target) return target;
  }
  return null;
}

async function legacyAdapterTarget(input, registry, submitCtx) {
  const defaultImageModel = submitCtx.config?.get?.("defaultImageModel") || null;
  try {
    const resolved = await resolveLegacyImageAdapter({
      registry,
      bus: submitCtx.bus,
      inputProvider: input.provider || "",
      inputModel: input.model || "",
      defaultImageModel,
    });
    if (resolved?.adapter) {
      return targetFromAdapter(resolved.adapter, input, {
        providerId: resolved.providerId || resolved.adapter.id,
        modelId: resolved.modelId || input.model || null,
        credentialProviderId: resolved.providerId || resolved.adapter.id,
      });
    }
  } catch {
    // Legacy resolver is best-effort only; missing media config should stay explicit.
  }

  return null;
}

export async function resolveImageTarget(input, registry, submitCtx) {
  if (input.provider) {
    return targetFromExplicitProvider(input, registry, submitCtx);
  }

  if (input.model) {
    const explicit = await targetFromExplicitModel(input, registry, submitCtx);
    if (explicit) return explicit;
    const legacy = await legacyAdapterTarget(input, registry, submitCtx);
    if (legacy) return legacy;
  }

  const configured = await targetFromConfiguredDefault(input, registry, submitCtx);
  if (configured) return configured;

  const available = await targetFromFirstAvailableProvider(input, registry, submitCtx);
  if (available) return available;

  return legacyAdapterTarget(input, registry, submitCtx);
}

export async function resolveImageAdapter(input, registry, submitCtx) {
  return (await resolveImageTarget(input, registry, submitCtx))?.adapter || null;
}

export function markSubmitFailed({ taskId, err, store, ctx }) {
  const message = errorMessage(err);
  const task = store.get?.(taskId);
  store.update(taskId, {
    status: "failed",
    failReason: message,
    submitState: "failed",
    completedAt: new Date().toISOString(),
  });
  if (!isResponseDelivery(task)) {
    ctx.bus.request("deferred:fail", { taskId, error: err }).catch(() => {});
    ctx.bus.request("task:remove", { taskId }).catch(() => {});
  }
  ctx.log?.error?.(`[image-gen] submit failed for ${taskId}:`, message);
}

export async function runSubmitInBackground({ taskId, adapter, params, submitCtx, store, poller, ctx }) {
  for (let attempt = 1; attempt <= TRANSIENT_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await adapter.submit(params, submitCtx);
      const hasProviderTaskId = typeof result?.taskId === "string" && result.taskId.trim();
      const adapterTaskId = hasProviderTaskId ? result.taskId : taskId;
      const files = Array.isArray(result?.files) ? result.files.filter(Boolean) : [];

      if (!hasProviderTaskId && files.length === 0) {
        throw new Error("Image generation provider returned no taskId or files");
      }

      store.update(taskId, {
        submitState: "submitted",
        adapterTaskId,
        ...(files.length ? { files } : {}),
      });

      if (files.length && typeof poller.checkNow === "function") {
        void poller.checkNow(taskId);
      }
      return;
    } catch (err) {
      if (attempt < TRANSIENT_SUBMIT_MAX_ATTEMPTS && isTransientSubmitError(err)) {
        const message = errorMessage(err);
        store.update(taskId, {
          submitState: "submitting",
          submitRetryCount: attempt,
          lastTransientError: message,
        });
        ctx.log?.warn?.(`[image-gen] transient submit failed for ${taskId}, retrying (${attempt}/${TRANSIENT_SUBMIT_MAX_ATTEMPTS - 1}):`, message);
        continue;
      }
      markSubmitFailed({ taskId, err, store, ctx });
      return;
    }
  }
}

function retryError(status, error) {
  return { ok: false, status, error };
}

function isRetryableTaskStatus(status) {
  return status === "failed" || status === "cancelled" || status === "aborted";
}

function normalizeRetryParams(task) {
  if (isObject(task.params) && typeof task.params.prompt === "string" && task.params.prompt.trim()) {
    return { ...task.params, type: task.type === "video" ? "video" : "image" };
  }
  if (typeof task.prompt === "string" && task.prompt.trim()) {
    return { type: task.type === "video" ? "video" : "image", prompt: task.prompt };
  }
  return null;
}

export async function retryMediaTask({ taskId, ctx }) {
  const { registry, store, poller } = ctx?._mediaGen || {};
  if (!registry || !store || !poller) {
    return retryError(503, "Media generation plugin is not initialized");
  }

  const task = store.get(taskId);
  if (!task) return retryError(404, "task not found");
  if (task.type !== "image" && task.type !== "video") return retryError(400, "only media tasks can be retried here");
  if (task.status === "pending") return retryError(409, "task is already running");
  if (!isRetryableTaskStatus(task.status)) return retryError(409, "task is not retryable");

  const sessionTarget = normalizeSessionRef(task);
  const { sessionId, sessionPath, sessionRef } = sessionTarget;
  const responseDelivery = isResponseDelivery(task);
  if (!sessionId && !sessionPath && !responseDelivery) return retryError(409, "task has no sessionId or sessionPath");

  const adapter = (task.protocolId && registry.getProtocol?.(task.protocolId))
    || registry.get(task.adapterId)
    || registry.get(task.providerId);
  if (!adapter || typeof adapter.submit !== "function") {
    return retryError(409, `adapter "${task.adapterId}" is unavailable`);
  }

  const params = normalizeRetryParams(task);
  if (!params) return retryError(409, "task has no reusable prompt");

  const prompt = typeof task.prompt === "string" && task.prompt.trim()
    ? task.prompt
    : params.prompt;
  const deliveryTarget = task.deliveryTarget || null;
  const kind = task.type === "video" ? "video" : "image";
  const meta = mediaDeferredMeta({ prompt, deliveryTarget, kind });

  if (!responseDelivery) {
    await ctx.bus.request("deferred:retry", { taskId, sessionId, sessionPath, sessionRef, meta });
  }

  const now = new Date().toISOString();
  store.update(taskId, {
    status: "pending",
    failReason: null,
    submitState: "submitting",
    adapterTaskId: null,
    files: [],
    sessionFiles: [],
    imageWidth: null,
    imageHeight: null,
    completedAt: null,
    createdAt: now,
    retriedAt: now,
    retryCount: Number(task.retryCount || 0) + 1,
  });

  if (!responseDelivery) {
    try {
      await ctx.bus.request("task:register", {
        taskId,
        type: "media-generation",
        sessionId,
        sessionRef,
        parentSessionPath: sessionPath,
        meta,
      });
    } catch {
      // TaskRegistry is runtime visibility only; DeferredResultStore owns delivery.
    }
  }

  poller.add(taskId);

  void runSubmitInBackground({
    taskId,
    adapter,
    params,
    submitCtx: createSubmitContext(ctx),
    store,
    poller,
    ctx,
  });

  return {
    ok: true,
    taskId,
    placeholder: {
      type: "media_generation",
      taskId,
      kind,
      ...(task.batchId ? { batchId: task.batchId } : {}),
      prompt,
      status: "pending",
    },
  };
}

export async function retryImageTask({ taskId, ctx }) {
  return retryMediaTask({ taskId, ctx });
}
