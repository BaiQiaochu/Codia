import fs from "node:fs";
import path from "node:path";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { t } from "../../lib/i18n.ts";
import { MediaAdapterRegistry, type MediaAdapter } from "../media-adapter-registry.ts";
import { createPluginConfigStore, normalizePluginConfigSchema } from "../plugin-config.ts";
import {
  normalizeImageGenerationConfig,
  normalizeVideoGenerationConfig,
} from "../preferences-manager.ts";
import { TaskStore } from "../../plugins/image-gen/lib/task-store.ts";
import { Poller } from "../../plugins/image-gen/lib/poller.ts";
import { submitImageGeneration } from "../../plugins/image-gen/lib/submit-image.ts";
import {
  isResponseDelivery,
  normalizeMediaDelivery,
  retryImageTask,
} from "../../plugins/image-gen/lib/image-task-runner.ts";
import { resolveMediaParameters } from "./media-parameters.ts";
import { builtinImageGenAdapters } from "../../plugins/image-gen/builtin-adapters.ts";

const log = createModuleLogger("media");
const IMAGE_CAPABILITY = "image_generation";
const VIDEO_CAPABILITY = "video_generation";

type UnknownRecord = Record<string, unknown>;
type Cleanup = () => void;
type LoggerLike = {
  error?: (...args: unknown[]) => void;
  info?: (message: string) => void;
  log?: (message: string) => void;
  warn?: (...args: unknown[]) => void;
};
type HandlerBus = {
  handle: (name: string, handler: (payload?: unknown) => unknown) => Cleanup | void;
  subscribe: (handler: (event: UnknownRecord) => void) => Cleanup | void;
  request: (name: string, payload?: unknown) => Promise<unknown>;
};
type SessionFileRegistryLike = {
  get?: (fileId: string, options: { sessionPath: string }) => {
    kind?: string;
    mime?: string;
    filePath?: string;
    realPath?: string;
  } | null | undefined;
};
type PreferencesLike = {
  getImageGenerationConfig?: () => unknown;
  setImageGenerationConfig?: (config: unknown) => void;
  getVideoGenerationConfig?: () => unknown;
  setVideoGenerationConfig?: (config: unknown) => void;
  hasImageGenerationLegacyConfigMigrated?: () => boolean;
  migrateImageGenerationConfigFromLegacy?: (legacy: unknown) => void;
};
type MediaModel = UnknownRecord & {
  aliases?: string[];
  credentialLaneId?: string | null;
  displayName?: string;
  id: string;
  name?: string;
  protocolId?: string | null;
};
type MediaProvider = UnknownRecord & {
  providerId: string;
  availableModels?: MediaModel[];
  models?: MediaModel[];
};
type ResolvedMediaModel = {
  providerId: string;
  model: MediaModel;
  credentialLane?: { id?: string | null; providerId?: string | null } | null;
};
type ProviderRegistryLike = {
  getMediaProviders: (capability: string) => MediaProvider[];
  getMediaProviderCredentialStatus?: (providerId: string, capability: string) => UnknownRecord;
  resolveMediaModel: (ref: UnknownRecord) => ResolvedMediaModel;
  addMediaModel?: (providerId: string, capability: string, model: unknown) => void;
  removeMediaModel?: (providerId: string, capability: string, modelId: string) => void;
};
type PollerLike = {
  add?: (taskId: string) => void;
  cancel?: (taskId: string) => void;
  start?: () => void;
  stop?: () => void;
};
type TaskStoreLike = {
  add: (task: UnknownRecord) => void;
  destroy?: () => void;
  get: (taskId: string) => (UnknownRecord & { files?: string[] }) | null | undefined;
  getByBatch: (batchId: string) => unknown[];
  listAll: () => (UnknownRecord & {
    adapterId?: string;
    batchId?: string;
    createdAt?: string;
    favorited?: boolean;
    status?: string;
    type?: string;
  })[];
  remove: (taskId: string) => void;
  removeUnfavorited: () => (UnknownRecord & { files?: string[] })[];
  update: (taskId: string, fields: UnknownRecord) => void;
};
type SpeechRecognitionLike = {
  transcribeAudio?: (payload: UnknownRecord) => Promise<unknown>;
  transcribeFile?: (payload: UnknownRecord) => Promise<unknown>;
  transcribeVoiceAttachment?: (payload: UnknownRecord) => Promise<unknown>;
};
type ConfigStoreLike = {
  getAll?: () => UnknownRecord;
  setMany?: (values: UnknownRecord) => void;
};
type MediaPayload = UnknownRecord & {
  bridgeContext?: unknown;
  count?: unknown;
  delivery?: unknown;
  deliveryMode?: unknown;
  deliveryTarget?: unknown;
  file?: unknown;
  fileId?: unknown;
  filePath?: unknown;
  image?: unknown;
  input?: UnknownRecord;
  kind?: unknown;
  language?: unknown;
  metadata?: unknown;
  mime?: unknown;
  mimeType?: unknown;
  model?: unknown;
  modelId?: unknown;
  path?: unknown;
  pluginId?: unknown;
  prompt?: unknown;
  provider?: unknown;
  quality?: unknown;
  ratio?: unknown;
  realPath?: unknown;
  referenceImages?: unknown;
  resolution?: unknown;
  sessionPath?: unknown;
  suggestedFilename?: unknown;
  type?: unknown;
};
type ImageSubmitResult = UnknownRecord & {
  tasks?: { taskId?: string }[];
};

const submitImageGenerationWithContext = submitImageGeneration as (args: {
  input?: UnknownRecord;
  ctx: unknown;
  metadata?: unknown;
  deliveryTarget?: unknown;
}) => Promise<ImageSubmitResult>;

const IMAGE_GENERATION_CONFIG_SCHEMA = normalizePluginConfigSchema("image-gen", {
  properties: {
    defaultImageModel: {
      type: "object",
      title: "Default image model",
      properties: {
        id: { type: "string" },
        provider: { type: "string" },
      },
    },
    providerDefaults: {
      type: "object",
      title: "Per-provider default parameters",
    },
  },
});

const VIDEO_GENERATION_CONFIG_SCHEMA = normalizePluginConfigSchema("video-gen", {
  properties: {
    defaultVideoModel: {
      type: "object",
      title: "Default video model",
      properties: {
        id: { type: "string" },
        provider: { type: "string" },
      },
    },
    providerDefaults: {
      type: "object",
      title: "Per-provider default parameters",
    },
  },
});

function isObject(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfigPatch(patch: unknown): UnknownRecord {
  const values = isObject(patch) ? patch : {};
  const next: UnknownRecord = {};
  if (Object.prototype.hasOwnProperty.call(values, "defaultImageModel")) {
    const value = values.defaultImageModel;
    if (value === undefined || value === null) {
      next.defaultImageModel = undefined;
    } else if (isObject(value)) {
      const provider = typeof value.provider === "string" ? value.provider.trim() : "";
      const id = typeof value.id === "string" ? value.id.trim() : "";
      if (!provider || !id) throw new Error("defaultImageModel requires provider and id");
      next.defaultImageModel = { provider, id };
    } else {
      throw new Error("defaultImageModel must be an object with provider and id");
    }
  }
  if (Object.prototype.hasOwnProperty.call(values, "providerDefaults")) {
    const value = values.providerDefaults;
    if (value === undefined || value === null) {
      next.providerDefaults = undefined;
    } else if (isObject(value)) {
      next.providerDefaults = structuredClone(value);
    } else {
      throw new Error("providerDefaults must be an object");
    }
  }
  return next;
}

function normalizeVideoConfigPatch(patch: unknown): UnknownRecord {
  const values = isObject(patch) ? patch : {};
  const next: UnknownRecord = {};
  if (Object.prototype.hasOwnProperty.call(values, "defaultVideoModel")) {
    const value = values.defaultVideoModel;
    if (value === undefined || value === null) {
      next.defaultVideoModel = undefined;
    } else if (isObject(value)) {
      const provider = typeof value.provider === "string" ? value.provider.trim() : "";
      const id = typeof value.id === "string" ? value.id.trim() : "";
      if (!provider || !id) throw new Error("defaultVideoModel requires provider and id");
      next.defaultVideoModel = { provider, id };
    } else {
      throw new Error("defaultVideoModel must be an object with provider and id");
    }
  }
  if (Object.prototype.hasOwnProperty.call(values, "providerDefaults")) {
    const value = values.providerDefaults;
    if (value === undefined || value === null) {
      next.providerDefaults = undefined;
    } else if (isObject(value)) {
      next.providerDefaults = structuredClone(value);
    } else {
      throw new Error("providerDefaults must be an object");
    }
  }
  return next;
}

function textOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function logInfo(logger: LoggerLike | null | undefined, message: string) {
  const fn = typeof logger?.info === "function"
    ? logger.info
    : typeof logger?.log === "function"
      ? logger.log
      : null;
  try {
    fn?.call(logger, message);
  } catch {
    // Logging must not break media adapter lifecycle changes.
  }
}

function normalizeImageInput(input: MediaPayload = {}, {
  sessionPath = null,
  sessionFiles = null,
  allowRawReferences = false,
}: {
  sessionPath?: string | null;
  sessionFiles?: SessionFileRegistryLike | null;
  allowRawReferences?: boolean;
} = {}) {
  const next = isObject(input) ? { ...input } : {};
  if (Object.prototype.hasOwnProperty.call(next, "referenceImages") && next.referenceImages !== undefined) {
    if (!Array.isArray(next.referenceImages)) {
      throw new Error("referenceImages must be an array of session_file references");
    }
    next.referenceImages = resolveImageReferences(next.referenceImages, {
      sessionPath,
      sessionFiles,
      allowRawReferences,
      fieldName: "referenceImages",
    });
  }
  if (Object.prototype.hasOwnProperty.call(next, "image") && next.image !== undefined) {
    const images = Array.isArray(next.image) ? next.image : [next.image];
    const resolved = resolveImageReferences(images, {
      sessionPath,
      sessionFiles,
      allowRawReferences,
      fieldName: "image",
    });
    next.image = Array.isArray(next.image) ? resolved : resolved[0];
  }
  if (Array.isArray(next.referenceImages) && next.referenceImages.length > 0 && next.image === undefined) {
    next.image = next.referenceImages;
  }
  return next;
}

function resolveImageReferences(references: unknown[], {
  sessionPath,
  sessionFiles,
  allowRawReferences,
  fieldName,
}: {
  sessionPath?: string | null;
  sessionFiles?: SessionFileRegistryLike | null;
  allowRawReferences?: boolean;
  fieldName: string;
}) {
  return references
    .map((reference) => resolveImageReference(reference, {
      sessionPath,
      sessionFiles,
      allowRawReferences,
      fieldName,
    }))
    .filter(Boolean);
}

function resolveImageReference(reference: unknown, {
  sessionPath,
  sessionFiles,
  allowRawReferences,
  fieldName,
}: {
  sessionPath?: string | null;
  sessionFiles?: SessionFileRegistryLike | null;
  allowRawReferences?: boolean;
  fieldName: string;
}) {
  if (typeof reference === "string") {
    const value = reference.trim();
    if (!value) return null;
    if (allowRawReferences) return value;
    throw new Error(`${fieldName} entries must be session_file references`);
  }
  if (!isObject(reference)) {
    throw new Error(`${fieldName} entries must be session_file references`);
  }
  const kind = textOrNull(reference.kind) || textOrNull(reference.type);
  if (kind !== "session_file") {
    throw new Error(`${fieldName} entries must use kind "session_file"`);
  }
  const fileId = textOrNull(reference.fileId) || textOrNull(reference.id);
  if (!fileId) throw new Error(`${fieldName} session_file reference requires fileId`);
  if (!sessionPath) throw new Error("sessionPath is required to resolve session_file references");
  if (!sessionFiles?.get) throw new Error("session file registry unavailable");
  const file = sessionFiles.get(fileId, { sessionPath });
  if (!file) throw new Error(`session file not found: ${fileId}`);
  if (file.kind !== "image" && !String(file.mime || "").startsWith("image/")) {
    throw new Error(`${fieldName} session_file must reference an image file`);
  }
  const filePath = textOrNull(file.filePath) || textOrNull(file.realPath);
  if (!filePath) throw new Error(`session file has no local path: ${fileId}`);
  return filePath;
}

function normalizeMediaKind(payload) {
  return textOrNull(payload?.kind) || textOrNull(payload?.type) || textOrNull(payload?.mediaKind) || "image";
}

function projectMediaProviderModel(model, adapterAvailable) {
  const name = model.displayName || model.name || model.id;
  return {
    ...model,
    id: model.id,
    name,
    displayName: name,
    protocolId: model.protocolId,
    credentialLaneId: model.credentialLaneId,
    adapterAvailable,
  };
}

export class UniversalMediaManager {
  declare _bus: HandlerBus | null;
  declare _config: ReturnType<UniversalMediaManager["_createConfigBridge"]>;
  declare _dataDir: string;
  declare _generatedDir: string;
  declare _handlerCleanups: Cleanup[];
  declare _legacyConfig: ConfigStoreLike;
  declare _log: LoggerLike;
  declare _onProviderChanged: () => Promise<void>;
  declare _poller: PollerLike | null;
  declare _preferences: PreferencesLike;
  declare _providers: ProviderRegistryLike;
  declare _registerSessionFile: (...args: unknown[]) => unknown;
  declare _registry: MediaAdapterRegistry;
  declare _sessionFiles: SessionFileRegistryLike | null;
  declare _speechRecognition: SpeechRecognitionLike | null;
  declare _store: TaskStoreLike;

  constructor({
    codiaHome,
    providerRegistry,
    preferences,
    speechRecognition = null,
    sessionFiles = null,
    registerSessionFile,
    onProviderChanged,
    logger = log,
  }: {
    codiaHome?: string;
    providerRegistry?: ProviderRegistryLike;
    preferences?: PreferencesLike;
    speechRecognition?: SpeechRecognitionLike | null;
    sessionFiles?: SessionFileRegistryLike | null;
    registerSessionFile?: (...args: unknown[]) => unknown;
    onProviderChanged?: () => Promise<void> | void;
    logger?: LoggerLike;
  } = {}) {
    const home = codiaHome || codiaHome;
    if (!home) throw new Error("UniversalMediaManager requires codiaHome");
    if (!providerRegistry) throw new Error("UniversalMediaManager requires providerRegistry");
    if (!preferences) throw new Error("UniversalMediaManager requires preferences");
    if (typeof registerSessionFile !== "function") throw new Error("UniversalMediaManager requires registerSessionFile");

    this._providers = providerRegistry;
    this._preferences = preferences;
    this._speechRecognition = speechRecognition || null;
    this._sessionFiles = sessionFiles || null;
    this._registerSessionFile = registerSessionFile;
    this._onProviderChanged = typeof onProviderChanged === "function"
      ? async () => { await onProviderChanged(); }
      : async () => {};
    this._log = logger;
    this._dataDir = path.join(home, "plugin-data", "image-gen");
    this._generatedDir = path.join(this._dataDir, "generated");
    fs.mkdirSync(this._generatedDir, { recursive: true });

    this._legacyConfig = createPluginConfigStore({
      dataDir: this._dataDir,
      schema: IMAGE_GENERATION_CONFIG_SCHEMA,
    });
    this._migrateLegacyImageConfig();
    this._config = this._createConfigBridge();

    this._registry = new MediaAdapterRegistry();
    this._store = new TaskStore(this._dataDir) as unknown as TaskStoreLike;
    this._poller = null;
    this._bus = null;
    this._handlerCleanups = [];
    this._registerBuiltinAdapters();
  }

  get dataDir() { return this._dataDir; }
  get generatedDir() { return this._generatedDir; }
  get registry() { return this._registry; }
  get store() { return this._store; }
  get poller() { return this._poller; }
  get config() { return this._config; }

  get runtime() {
    return {
      registry: this._registry,
      store: this._store,
      poller: this._poller,
      generatedDir: this._generatedDir,
    };
  }

  _registerBuiltinAdapters() {
    for (const adapter of builtinImageGenAdapters) {
      this.registerAdapter(adapter);
    }
  }

  _createConfigBridge() {
    return {
      get: (key) => {
        const config = this.getImageConfig();
        if (!key) return structuredClone(config);
        return config[key];
      },
      getAll: () => {
        return structuredClone(this.getImageConfig());
      },
      set: (key, value) => {
        return this.setImageConfig({ [key]: value });
      },
      setMany: (values) => {
        return this.setImageConfig(values);
      },
      getSchema() {
        return structuredClone(IMAGE_GENERATION_CONFIG_SCHEMA);
      },
    };
  }

  _createVideoConfigBridge() {
    return {
      get: (key) => {
        const config = this.getVideoConfig();
        if (!key) return structuredClone(config);
        return config[key];
      },
      getAll: () => {
        return structuredClone(this.getVideoConfig());
      },
      getSchema() {
        return structuredClone(VIDEO_GENERATION_CONFIG_SCHEMA);
      },
    };
  }

  _migrateLegacyImageConfig() {
    if (this._preferences.hasImageGenerationLegacyConfigMigrated?.()) return;
    if (typeof this._preferences.migrateImageGenerationConfigFromLegacy !== "function") return;
    const legacy = this._legacyConfig.getAll?.() || {};
    this._preferences.migrateImageGenerationConfigFromLegacy(legacy);
  }

  getImageConfig() {
    const native = normalizeImageGenerationConfig(this._preferences.getImageGenerationConfig?.() || {});
    if (Object.keys(native).length > 0) return native;
    return normalizeImageGenerationConfig(this._legacyConfig.getAll?.() || {});
  }

  setImageConfig(patch) {
    const updates = normalizeConfigPatch(patch);
    this._validateImageConfigPatch(updates);
    const current = this.getImageConfig();
    const next = { ...current };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const normalized = normalizeImageGenerationConfig(next);
    this._preferences.setImageGenerationConfig?.(normalized);
    this._legacyConfig.setMany?.(updates);
    return structuredClone(normalized);
  }

  getVideoConfig() {
    return normalizeVideoGenerationConfig(this._preferences.getVideoGenerationConfig?.() || {});
  }

  setVideoConfig(patch) {
    const updates = normalizeVideoConfigPatch(patch);
    this._validateVideoConfigPatch(updates);
    const current = this.getVideoConfig();
    const next = { ...current };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const normalized = normalizeVideoGenerationConfig(next);
    this._preferences.setVideoGenerationConfig?.(normalized);
    return structuredClone(normalized);
  }

  _validateVideoConfigPatch(updates) {
    if (!Object.prototype.hasOwnProperty.call(updates, "defaultVideoModel")) return;
    const value = updates.defaultVideoModel;
    if (value === undefined || value === null) return;
    this.resolveVideoModelRef({ providerId: value.provider, modelId: value.id });
  }

  async validateVideoConfigPatch(updates) {
    const patch = normalizeVideoConfigPatch(updates);
    this._validateVideoConfigPatch(patch);
    return null;
  }

  _validateImageConfigPatch(updates) {
    if (!Object.prototype.hasOwnProperty.call(updates, "defaultImageModel")) return;
    const value = updates.defaultImageModel;
    if (value === undefined || value === null) return;
    this.resolveImageModelRef({ providerId: value.provider, modelId: value.id });
  }

  async validateImageConfigPatch(updates) {
    const patch = normalizeConfigPatch(updates);
    this._validateImageConfigPatch(patch);
    return null;
  }

  registerAdapter(adapter: MediaAdapter) {
    this._registry.register(adapter);
  }

  unregisterAdapter(adapterId: string) {
    this._registry.unregister(adapterId);
  }

  start(bus: HandlerBus) {
    if (!bus) throw new Error("UniversalMediaManager.start requires bus");
    if (this._bus === bus && this._poller) return;
    this.stop({ keepStore: true });
    this._bus = bus;
    this._poller = new Poller({
      store: this._store,
      registry: this._registry,
      bus,
      dataDir: this._dataDir,
      generatedDir: this._generatedDir,
      log: this._log,
      registerSessionFile: this._registerSessionFile,
    }) as PollerLike;
    this._registerBusHandlers(bus);
    this._poller.start();
  }

  stop({ keepStore = false }: { keepStore?: boolean } = {}) {
    for (const cleanup of this._handlerCleanups.splice(0)) {
      try { cleanup?.(); } catch {}
    }
    this._poller?.stop?.();
    this._poller = null;
    this._bus = null;
    if (!keepStore) this._store.destroy?.();
  }

  dispose() {
    this.stop();
  }

  _registerBusHandlers(bus: HandlerBus) {
    const cleanups = [
      bus.handle("media:runtime", () => ({
        ok: true,
        runtime: this.runtime,
        config: this._config,
        dataDir: this._dataDir,
        generatedDir: this._generatedDir,
      })),
      bus.handle("media:generate", (payload: unknown = {}) => this.generateMedia(payload as MediaPayload)),
      bus.handle("media:generate-image", (payload: unknown = {}) => this.generateImageFromBus(payload as MediaPayload)),
      bus.handle("media:generate-video", (payload: unknown = {}) => this.generateVideoFromBus(payload as MediaPayload)),
      bus.handle("media:transcribe-audio", (payload: unknown = {}) => this.transcribeAudio(payload as MediaPayload)),
      bus.handle("media-gen:register-adapter", (payload: unknown = {}) => {
        const { adapter } = payload as { adapter?: MediaAdapter };
        if (!adapter) throw new Error("media adapter is required");
        this.registerAdapter(adapter);
        logInfo(this._log, `adapter registered: ${adapter?.id}`);
        return { ok: true };
      }),
      bus.handle("media-gen:unregister-adapter", (payload: unknown = {}) => {
        const { adapterId } = payload as { adapterId?: string };
        if (!adapterId) throw new Error("adapterId is required");
        this.unregisterAdapter(adapterId);
        logInfo(this._log, `adapter unregistered: ${adapterId}`);
        return { ok: true };
      }),
      bus.subscribe((event) => {
        if (event?.type !== "media-gen:adapter-removed" || !event.adapterId) return;
        this.unregisterAdapter(String(event.adapterId));
        logInfo(this._log, `adapter removed (event): ${event.adapterId}`);
      }),
      bus.handle("media-gen:list-adapters", () => ({
        adapters: this._registry.list().map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          types: adapter.types,
        })),
      })),
      bus.handle("media-gen:submit-image", async (payload: unknown = {}) => {
        try {
          return await this.generateImageFromBus(payload as MediaPayload, { allowRawReferences: true });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
      bus.handle("media-gen:get-tasks", (payload: unknown = {}) => {
        const { adapterId, batchId, status } = payload as { adapterId?: string; batchId?: string; status?: string };
        return { tasks: this.listTasks({ adapterId, batchId, status }) };
      }),
      bus.handle("media-gen:get-task", (payload: unknown = {}) => {
        const { taskId } = payload as { taskId?: string };
        return { task: taskId ? this.getTask(taskId) : null };
      }),
      bus.handle("media-gen:update-task", (payload: unknown = {}) => {
        const { taskId, fields } = payload as { taskId?: string; fields?: UnknownRecord };
        if (!taskId) throw new Error("taskId is required");
        return this.updateTask(taskId, fields || {});
      }),
      bus.handle("media-gen:remove-task", (payload: unknown = {}) => {
        const { taskId } = payload as { taskId?: string };
        if (!taskId) throw new Error("taskId is required");
        return this.removeTask(taskId);
      }),
      bus.handle("media-gen:remove-unfavorited", () => this.removeUnfavorited()),
    ];

    bus.request("task:register-handler", {
      type: "media-generation",
      abort: (taskId: string) => { this._poller?.cancel?.(taskId); },
    }).catch(() => {});
    cleanups.push(() => {
      bus.request("task:unregister-handler", { type: "media-generation" }).catch(() => {});
    });

    this._handlerCleanups.push(...cleanups.filter((cleanup): cleanup is Cleanup => typeof cleanup === "function"));
  }

  _submitContext() {
    return {
      dataDir: this._dataDir,
      bus: this._bus,
      log: this._log,
      generatedDir: this._generatedDir,
      config: this._config,
      videoConfig: this._createVideoConfigBridge(),
    };
  }

  _toolContext({
    sessionPath = null,
    bridgeContext = null,
  }: { sessionPath?: string | null; bridgeContext?: unknown } = {}) {
    return {
      dataDir: this._dataDir,
      bus: this._bus,
      log: this._log,
      config: this._config,
      videoConfig: this._createVideoConfigBridge(),
      sessionPath,
      bridgeContext,
      _mediaGen: this.runtime,
    };
  }

  async generateMedia(payload: MediaPayload = {}) {
    const kind = normalizeMediaKind(payload);
    if (kind === "image" || kind === "image_generation" || kind === "imageGeneration") {
      return this.generateImageFromBus(payload);
    }
    if (kind === "video" || kind === "video_generation" || kind === "videoGeneration") {
      return this.generateVideoFromBus(payload);
    }
    if (kind === "audio" || kind === "speech_recognition" || kind === "transcription" || kind === "asr") {
      return this.transcribeAudio(payload);
    }
    throw new Error(`unsupported media kind: ${kind}`);
  }

  async generateImageFromBus(
    payload: MediaPayload = {},
    { allowRawReferences = false }: { allowRawReferences?: boolean } = {},
  ) {
    const sessionPath = textOrNull(payload.sessionPath);
    const inputSource = payload.input && isObject(payload.input)
      ? {
        ...payload.input,
        ...(payload.delivery !== undefined ? { delivery: payload.delivery } : {}),
        ...(payload.deliveryMode !== undefined ? { deliveryMode: payload.deliveryMode } : {}),
      }
      : {
        prompt: payload.prompt,
        count: payload.count,
        image: payload.image,
        referenceImages: payload.referenceImages,
        ratio: payload.ratio,
        resolution: payload.resolution,
        quality: payload.quality,
        model: payload.model,
        provider: payload.provider,
        suggestedFilename: payload.suggestedFilename,
        delivery: payload.delivery,
        deliveryMode: payload.deliveryMode,
      };
    const delivery = normalizeMediaDelivery(inputSource);
    if (!sessionPath && !isResponseDelivery(delivery)) throw new Error("sessionPath is required");
    const input = normalizeImageInput({
      ...inputSource,
      delivery,
    }, {
      sessionPath,
      sessionFiles: this._sessionFiles,
      allowRawReferences,
    });
    if (Array.isArray(input.image) && input.image.length > 1) {
      input._compatImageArrayAlias = true;
    }
    if (!textOrNull(input.prompt)) throw new Error("prompt is required");
    return this.submitImage({
      input,
      sessionPath,
      metadata: {
        ...(isObject(payload.metadata) ? payload.metadata : {}),
        ...(textOrNull(payload.pluginId) ? { pluginId: textOrNull(payload.pluginId) } : {}),
      },
      ...(payload.deliveryTarget !== undefined ? { deliveryTarget: payload.deliveryTarget } : {}),
      ...(payload.bridgeContext ? { bridgeContext: payload.bridgeContext } : {}),
    });
  }

  async submitImage({
    input,
    sessionPath,
    metadata = null,
    deliveryTarget = undefined,
    bridgeContext = null,
  }: {
    input?: UnknownRecord;
    sessionPath?: string | null;
    metadata?: unknown;
    deliveryTarget?: unknown;
    bridgeContext?: unknown;
  } = {}) {
    if (!this._bus || !this._poller) throw new Error(t("plugin.imageGen.notInitialized"));
    return submitImageGenerationWithContext({
      input,
      ctx: this._toolContext({ sessionPath, bridgeContext }),
      metadata,
      deliveryTarget,
    });
  }

  async generateVideoFromBus(payload: MediaPayload = {}) {
    const sessionPath = textOrNull(payload.sessionPath);
    const inputSource = payload.input && isObject(payload.input)
      ? {
        ...payload.input,
        ...(payload.delivery !== undefined ? { delivery: payload.delivery } : {}),
        ...(payload.deliveryMode !== undefined ? { deliveryMode: payload.deliveryMode } : {}),
      }
      : payload;
    const delivery = normalizeMediaDelivery(inputSource);
    if (!sessionPath && !isResponseDelivery(delivery)) throw new Error("sessionPath is required");
    const input = normalizeImageInput({
      ...inputSource,
      delivery,
    }, {
      sessionPath,
      sessionFiles: this._sessionFiles,
      allowRawReferences: false,
    });
    return this.submitVideo({ input, sessionPath });
  }

  async submitVideo({ input = {}, sessionPath }: { input?: UnknownRecord; sessionPath?: string | null } = {}) {
    if (!this._bus || !this._poller) throw new Error(t("plugin.imageGen.notInitialized"));
    if (!textOrNull(input.prompt)) throw new Error("prompt is required");
    const delivery = normalizeMediaDelivery(input);
    const responseDelivery = isResponseDelivery(delivery);
    if (!sessionPath && !responseDelivery) throw new Error("sessionPath is required");
    const target = this._resolveVideoTarget(input);
    const adapter = target?.adapter || null;
    if (!adapter) throw new Error(t("toolDef.generateVideo.noProvider"));
    const providerDefaults = this.getVideoConfig()?.providerDefaults?.[target.providerId] || {};
    const parameterResolution = resolveMediaParameters({
      kind: "video",
      input,
      providerId: target.providerId,
      model: target.model,
      providerDefaults,
    });

    const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const params = {
      type: "video",
      prompt: input.prompt,
      ...parameterResolution.resolvedParameters,
      ...(input.image && { image: input.image }),
      mode: parameterResolution.modeId,
      resolvedParameters: parameterResolution.resolvedParameters,
      ...(target?.providerId ? { providerId: target.providerId } : {}),
      ...(target?.modelId ? { modelId: target.modelId, model: target.modelId } : (input.model ? { model: input.model } : {})),
      ...(target?.protocolId ? { protocolId: target.protocolId } : {}),
      ...(target?.credentialLaneId ? { credentialLaneId: target.credentialLaneId } : {}),
      ...(target?.credentialProviderId ? { credentialProviderId: target.credentialProviderId } : {}),
    };
    const result = await adapter.submit(params, this._submitContext());
    if (!result?.taskId) throw new Error(t("toolDef.generateVideo.submitFailedUnknown"));

    this._store.add({
      taskId: result.taskId,
      adapterId: adapter.id,
      ...(result.providerTaskId || result.adapterTaskId ? { adapterTaskId: result.providerTaskId || result.adapterTaskId } : {}),
      batchId,
      type: "video",
      prompt: input.prompt,
      params,
      sessionPath,
      deliveryMode: delivery.mode,
      delivery,
      ...(target?.providerId ? { providerId: target.providerId } : {}),
      ...(target?.modelId ? { modelId: target.modelId } : {}),
      ...(target?.protocolId ? { protocolId: target.protocolId } : {}),
      ...(target?.credentialLaneId ? { credentialLaneId: target.credentialLaneId } : {}),
      ...(target?.credentialProviderId ? { credentialProviderId: target.credentialProviderId } : {}),
    });
    if (result.files?.length) {
      this._store.update(result.taskId, { files: result.files });
    }

    if (!responseDelivery) {
      await this._bus.request("deferred:register", {
        taskId: result.taskId,
        sessionPath,
        meta: {
          type: "video-generation",
          mediaKind: "video",
          deliveryIntent: "ui_only",
          triggerParentTurn: false,
          prompt: input.prompt,
        },
      }).catch((err) => {
        this._log.warn(`deferred:register failed for ${result.taskId}:`, err);
      });
      await this._bus.request("task:register", {
        taskId: result.taskId,
        type: "media-generation",
        parentSessionPath: sessionPath,
        meta: { type: "video-generation", prompt: input.prompt },
      }).catch(() => {});
    }
    this._poller.add(result.taskId);

    return {
      ok: true,
      kind: "video",
      batchId,
      prompt: input.prompt,
      delivery,
      tasks: [{ taskId: result.taskId }],
    };
  }

  _resolveVideoTarget(input: MediaPayload = {}) {
    const providerId = textOrNull(input.provider);
    const modelId = textOrNull(input.model) || textOrNull(input.modelId);

    if (providerId && modelId) {
      try {
        return this._videoTargetFromMediaRef({ providerId, modelId });
      } catch (err) {
        const legacyAdapter = this._registry.get(providerId);
        if (legacyAdapter) {
          return {
            adapter: legacyAdapter,
            providerId,
            modelId,
            model: null,
            protocolId: legacyAdapter.protocolId || null,
            credentialLaneId: null,
            credentialProviderId: providerId,
          };
        }
        throw err;
      }
    }

    if (providerId) {
      const provider = this._providers.getMediaProviders(VIDEO_CAPABILITY)
        .find((item) => item.providerId === providerId);
      for (const model of provider?.models || []) {
        const target = this._videoTargetFromMediaRef({ providerId, modelId: model.id }, { strict: false });
        if (target) return target;
      }
      const adapter = this._registry.get(providerId);
      if (adapter) {
        return {
          adapter,
          providerId,
          modelId: null,
          model: null,
          protocolId: adapter.protocolId || null,
          credentialLaneId: null,
          credentialProviderId: providerId,
        };
      }
      return null;
    }

    if (modelId) {
      const matches = [];
      for (const provider of this._providers.getMediaProviders(VIDEO_CAPABILITY) || []) {
        if (provider.models?.some?.((model) => model.id === modelId || model.aliases?.includes?.(modelId))) {
          matches.push({ providerId: provider.providerId, modelId });
        }
      }
      if (matches.length > 1) throw new Error(`Video model "${modelId}" is available from multiple providers`);
      if (matches.length === 1) return this._videoTargetFromMediaRef(matches[0]);
      throw new Error(`Video model "${modelId}" not found`);
    }

    const defaultModel = this.getVideoConfig()?.defaultVideoModel;
    if (defaultModel?.provider && defaultModel.id) {
      return this._videoTargetFromMediaRef({
        providerId: defaultModel.provider,
        modelId: defaultModel.id,
      });
    }

    for (const provider of this._providers.getMediaProviders(VIDEO_CAPABILITY) || []) {
      for (const model of provider.models || []) {
        const target = this._videoTargetFromMediaRef({ providerId: provider.providerId, modelId: model.id }, { strict: false });
        if (target) return target;
      }
    }

    const adapter = this._registry.getByType("video").at(-1) || null;
    if (!adapter) return null;
    return {
      adapter,
      providerId: adapter.id || null,
      modelId: null,
      model: null,
      protocolId: adapter.protocolId || null,
      credentialLaneId: null,
      credentialProviderId: adapter.id || null,
    };
  }

  _videoTargetFromMediaRef(
    ref: { providerId?: string | null; modelId?: string | null },
    { strict = true }: { strict?: boolean } = {},
  ) {
    let resolved;
    try {
      resolved = this._providers.resolveMediaModel({
        providerId: ref.providerId,
        modelId: ref.modelId,
        capability: VIDEO_CAPABILITY,
      });
    } catch (err) {
      if (strict) throw err;
      return null;
    }
    const protocolId = resolved?.model?.protocolId;
    if (!protocolId) {
      if (strict) throw new Error(`Media model "${ref.providerId}/${ref.modelId}" missing protocolId`);
      return null;
    }
    const adapter = this._registry.getProtocol?.(protocolId) || this._registry.get?.(resolved.providerId);
    if (!adapter) {
      if (strict) throw new Error(`No video generation adapter registered for protocol "${protocolId}"`);
      return null;
    }
    return {
      adapter,
      providerId: resolved.providerId,
      modelId: resolved.model.id,
      model: resolved.model,
      protocolId,
      credentialLaneId: resolved.credentialLane?.id || null,
      credentialProviderId: resolved.credentialLane?.providerId || resolved.providerId,
    };
  }

  resolveVideoModelRef(ref: { providerId?: string; provider?: string; modelId?: string; id?: string; model?: string } = {}) {
    const providerId = ref.providerId || ref.provider;
    const modelId = ref.modelId || ref.id || ref.model;
    const target = this._videoTargetFromMediaRef({ providerId, modelId });
    return {
      providerId: target.providerId,
      modelId: target.modelId,
      protocolId: target.protocolId,
      adapterId: target.adapter?.id || null,
      credentialLaneId: target.credentialLaneId || null,
      credentialProviderId: target.credentialProviderId || target.providerId,
    };
  }

  async retryImageTask(taskId) {
    return retryImageTask({ taskId, ctx: this._toolContext() });
  }

  listTasks({
    adapterId,
    batchId,
    status,
    filter,
  }: { adapterId?: string; batchId?: string; status?: string; filter?: string } = {}) {
    let tasks = this._store.listAll();
    if (adapterId) tasks = tasks.filter((task) => task.adapterId === adapterId);
    if (batchId) tasks = tasks.filter((task) => task.batchId === batchId);
    if (status) tasks = tasks.filter((task) => task.status === status);
    if (filter === "favorited") tasks = tasks.filter((task) => task.favorited);
    if (filter === "images") tasks = tasks.filter((task) => task.type === "text2image" || task.type === "image2image" || task.type === "image");
    if (filter === "videos") tasks = tasks.filter((task) => task.type?.includes?.("video"));
    tasks.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return tasks;
  }

  getTask(taskId) {
    return this._store.get(taskId);
  }

  getTasksByBatch(batchId) {
    return this._store.getByBatch(batchId);
  }

  updateTask(taskId, fields) {
    const allowed: UnknownRecord = {};
    if (typeof fields?.favorited === "boolean") allowed.favorited = fields.favorited;
    this._store.update(taskId, allowed);
    return { ok: true };
  }

  removeTask(taskId) {
    const task = this._store.get(taskId);
    if (task) {
      for (const file of task.files || []) this._removeGeneratedFile(file);
      this._store.remove(taskId);
    }
    return { ok: true };
  }

  removeUnfavorited() {
    const removed = this._store.removeUnfavorited();
    for (const task of removed) {
      for (const file of task.files || []) this._removeGeneratedFile(file);
    }
    return { ok: true, removed: removed.length };
  }

  _removeGeneratedFile(filename) {
    try { fs.unlinkSync(path.join(this._generatedDir, filename)); } catch {}
  }

  generatedFilePath(filename) {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      throw new Error("invalid filename");
    }
    return path.join(this._generatedDir, filename);
  }

  async listImageProviders() {
    const providers: Record<string, unknown> = {};
    for (const provider of this._providers.getMediaProviders(IMAGE_CAPABILITY) || []) {
      const credentialStatus = this._providers.getMediaProviderCredentialStatus?.(provider.providerId, IMAGE_CAPABILITY) || {};
      const models = (provider.models || [])
        .map((model) => projectMediaProviderModel(
          model,
          this.hasAdapterForImageModel(provider.providerId, model),
        ))
        .filter((model) => {
          if (model.adapterAvailable) return true;
          this._log.warn(
            `[media] settings hide image model "${provider.providerId}/${model.id}": `
            + (model.protocolId
              ? `no adapter registered for protocol "${model.protocolId}"`
              : "protocol unrecognized (model has no protocolId)"),
          );
          return false;
        });
      if (!models.length) continue;
      const modelIds = new Set(models.map((model) => model.id));
      providers[provider.providerId] = {
        ...provider,
        ...credentialStatus,
        hasCredentials: credentialStatus.hasCredentials === true,
        unavailableReason: credentialStatus.unavailableReason || null,
        credentialLanes: credentialStatus.lanes,
        activeCredentialLaneId: credentialStatus.activeLaneId || null,
        activeCredentialProviderId: credentialStatus.activeProviderId || null,
        models,
        availableModels: Array.isArray(provider.availableModels)
          ? provider.availableModels.filter((model) => modelIds.has(model.id))
          : [],
      };
    }
    return {
      providers,
      config: this.getImageConfig(),
    };
  }

  hasAdapterForImageModel(providerId, model) {
    if (!model?.protocolId) return false;
    return Boolean(this._registry.getProtocol?.(model.protocolId) || this._registry.get(providerId));
  }

  async listVideoProviders() {
    const providers: Record<string, unknown> = {};
    for (const provider of this._providers.getMediaProviders(VIDEO_CAPABILITY) || []) {
      const credentialStatus = this._providers.getMediaProviderCredentialStatus?.(provider.providerId, VIDEO_CAPABILITY) || {};
      const models = (provider.models || [])
        .map((model) => projectMediaProviderModel(
          model,
          this.hasAdapterForVideoModel(provider.providerId, model),
        ))
        .filter((model) => {
          if (model.adapterAvailable) return true;
          this._log.warn(
            `[media] settings hide video model "${provider.providerId}/${model.id}": `
            + (model.protocolId
              ? `no adapter registered for protocol "${model.protocolId}"`
              : "protocol unrecognized (model has no protocolId)"),
          );
          return false;
        });
      if (!models.length) continue;
      const modelIds = new Set(models.map((model) => model.id));
      providers[provider.providerId] = {
        ...provider,
        ...credentialStatus,
        hasCredentials: credentialStatus.hasCredentials === true,
        unavailableReason: credentialStatus.unavailableReason || null,
        credentialLanes: credentialStatus.lanes,
        activeCredentialLaneId: credentialStatus.activeLaneId || null,
        activeCredentialProviderId: credentialStatus.activeProviderId || null,
        models,
        availableModels: Array.isArray(provider.availableModels)
          ? provider.availableModels.filter((model) => modelIds.has(model.id))
          : [],
      };
    }
    return {
      providers,
      config: this.getVideoConfig(),
    };
  }

  hasAdapterForVideoModel(providerId, model) {
    if (!model?.protocolId) return false;
    return Boolean(this._registry.getProtocol?.(model.protocolId) || this._registry.get(providerId));
  }

  resolveImageModelRef(ref: {
    providerId?: string;
    provider?: string;
    modelId?: string;
    id?: string;
    model?: string;
    credentialLaneId?: string;
  } = {}) {
    const providerId = ref.providerId || ref.provider;
    const modelId = ref.modelId || ref.id || ref.model;
    const resolved = this._providers.resolveMediaModel({
      providerId,
      modelId,
      capability: IMAGE_CAPABILITY,
      ...(ref.credentialLaneId ? { credentialLaneId: ref.credentialLaneId } : {}),
    });
    const protocolId = resolved?.model?.protocolId;
    if (!protocolId) throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
    const adapter = this._registry.getProtocol?.(protocolId) || this._registry.get?.(resolved.providerId);
    if (!adapter) throw new Error(`No image generation adapter registered for protocol "${protocolId}"`);
    return {
      providerId: resolved.providerId,
      modelId: resolved.model.id,
      protocolId,
      adapterId: adapter.id || null,
      credentialLaneId: resolved.credentialLane?.id || null,
      credentialProviderId: resolved.credentialLane?.providerId || resolved.providerId,
    };
  }

  async setImageProviderModel(providerId, model) {
    if (typeof this._providers.addMediaModel !== "function") throw new Error("media provider registry is read-only");
    this._providers.addMediaModel(providerId, IMAGE_CAPABILITY, model);
    await this._onProviderChanged();
    return { ok: true };
  }

  async removeImageProviderModel(providerId, modelId) {
    if (typeof this._providers.removeMediaModel !== "function") throw new Error("media provider registry is read-only");
    this._providers.removeMediaModel(providerId, IMAGE_CAPABILITY, modelId);
    await this._onProviderChanged();
    return { ok: true };
  }

  async setVideoProviderModel(providerId, model) {
    if (typeof this._providers.addMediaModel !== "function") throw new Error("media provider registry is read-only");
    this._providers.addMediaModel(providerId, VIDEO_CAPABILITY, model);
    await this._onProviderChanged();
    return { ok: true };
  }

  async removeVideoProviderModel(providerId, modelId) {
    if (typeof this._providers.removeMediaModel !== "function") throw new Error("media provider registry is read-only");
    this._providers.removeMediaModel(providerId, VIDEO_CAPABILITY, modelId);
    await this._onProviderChanged();
    return { ok: true };
  }

  async transcribeAudio(payload: MediaPayload = {}) {
    if (this._speechRecognition?.transcribeAudio) {
      return normalizeTranscribeAudioResult(await this._speechRecognition.transcribeAudio(payload));
    }
    if (payload?.sessionPath && payload?.fileId && this._speechRecognition?.transcribeVoiceAttachment) {
      return normalizeTranscribeAudioResult(await this._speechRecognition.transcribeVoiceAttachment(payload));
    }
    if (this._speechRecognition?.transcribeFile) {
      const file = payload?.file || {
        filePath: payload?.filePath || payload?.path || payload?.realPath,
        realPath: payload?.realPath || payload?.filePath || payload?.path,
        mime: payload?.mime || payload?.mimeType,
      };
      return normalizeTranscribeAudioResult(await this._speechRecognition.transcribeFile({
        file,
        language: payload?.language,
      }));
    }
    throw new Error("speech recognition service unavailable");
  }
}

function normalizeTranscribeAudioResult(result) {
  if (isObject(result) && result.ok === true && Object.prototype.hasOwnProperty.call(result, "transcription")) {
    return result;
  }
  if (isObject(result) && Object.prototype.hasOwnProperty.call(result, "text")) {
    return { ok: true, transcription: result.text, result };
  }
  return { ok: true, transcription: result };
}
