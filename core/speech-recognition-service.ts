// @ts-nocheck
import { MediaAdapterRegistry } from "./media-adapter-registry.ts";
import { builtinSpeechRecognitionAdapters } from "./speech-recognition/adapters.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const CAPABILITY = "speech_recognition";
const log = createModuleLogger("speech-recognition");

export class SpeechRecognitionService {
  constructor({
    providerRegistry,
    preferences,
    sessionFiles,
    emitEvent,
    fetch,
    logger = log,
    adapters = builtinSpeechRecognitionAdapters,
  } = {}) {
    if (!providerRegistry) throw new Error("SpeechRecognitionService requires providerRegistry");
    if (!preferences) throw new Error("SpeechRecognitionService requires preferences");
    if (!sessionFiles) throw new Error("SpeechRecognitionService requires sessionFiles");
    this._providers = providerRegistry;
    this._prefs = preferences;
    this._sessionFiles = sessionFiles;
    this._emitEvent = typeof emitEvent === "function" ? emitEvent : () => {};
    this._fetch = fetch;
    this._logger = logger;
    this._registry = new MediaAdapterRegistry();
    for (const adapter of adapters || []) this.registerAdapter(adapter);
  }

  registerAdapter(adapter) {
    this._registry.register(adapter);
  }

  unregisterAdapter(adapterId) {
    this._registry.unregister(adapterId);
  }

  hasAdapterForModel(providerId, model) {
    if (!model?.protocolId) return false;
    return Boolean(this._registry.getProtocol(model.protocolId) || this._registry.get(providerId));
  }

  listProviders() {
    const next = {};
    for (const provider of this._providers.getMediaProviders(CAPABILITY) || []) {
      const providerId = provider.providerId;
      const providerModels = typeof this._providers.getRegisteredMediaModels === "function"
        ? this._providers.getRegisteredMediaModels(providerId, CAPABILITY)
        : provider.models || [];
      const models = (providerModels || [])
        .map((model) => ({
          ...model,
          adapterAvailable: this.hasAdapterForModel(providerId, model),
        }))
        .filter((model) => model.adapterAvailable);
      if (!models.length) continue;
      const credentialStatus = this._providers.getMediaProviderCredentialStatus?.(providerId, CAPABILITY) || {};
      next[providerId] = {
        ...provider,
        ...credentialStatus,
        models,
        availableModels: models.map((model) => ({
          id: model.id,
          name: model.displayName || model.name || model.id,
        })),
      };
    }
    return {
      providers: next,
      config: this.getConfig(),
    };
  }

  getConfig() {
    return this._prefs.getSpeechRecognitionConfig?.() || { enabled: false };
  }

  setConfig(patch) {
    const next = normalizeSpeechRecognitionConfigPatch(patch, this.getConfig());
    if (next.defaultModel) {
      const listed = this.listProviders().providers;
      const provider = listed[next.defaultModel.provider];
      if (!provider?.models?.some((model) => model.id === next.defaultModel.id)) {
        throw new Error("speech recognition default model is unavailable");
      }
    }
    return this._prefs.setSpeechRecognitionConfig?.(next) || next;
  }

  async queueVoiceTranscription({ sessionPath, fileId, language } = {}) {
    Promise.resolve()
      .then(() => this.transcribeVoiceAttachment({ sessionPath, fileId, language }))
      .catch((err) => {
        this._logger?.warn?.(`voice transcription queue failed for ${fileId || "(missing fileId)"}: ${err?.message || err}`);
      });
  }

  async transcribeVoiceAttachment({ sessionPath, fileId, language } = {}) {
    const config = this.getConfig();
    if (!config.enabled || !config.defaultModel) return { status: "skipped", reason: "disabled" };
    if (!sessionPath || !fileId) throw new Error("sessionPath and fileId are required for voice transcription");

    const file = this._sessionFiles.get(fileId, { sessionPath });
    if (!file) throw new Error(`session file not found: ${fileId}`);
    if (file.presentation !== "voice-input") return { status: "skipped", reason: "not_voice_input" };

    const target = this._resolveTarget(config.defaultModel);
    const pending = this._updateTranscription(sessionPath, fileId, {
      status: "pending",
      providerId: target.providerId,
      modelId: target.model.id,
      protocolId: target.model.protocolId,
      ...(language ? { language } : {}),
    });
    this._emitTranscriptionUpdate(sessionPath, fileId, pending.transcription);

    try {
      const result = await this._runAdapter({ target, file, language });
      const ready = this._updateTranscription(sessionPath, fileId, {
        status: "ready",
        text: result.text || "",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(result.language ? { language: result.language } : language ? { language } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
      this._emitTranscriptionUpdate(sessionPath, fileId, ready.transcription);
      return ready.transcription;
    } catch (err) {
      const failed = this._updateTranscription(sessionPath, fileId, {
        status: "failed",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(language ? { language } : {}),
        error: err?.message || String(err),
      });
      this._emitTranscriptionUpdate(sessionPath, fileId, failed.transcription);
      return failed.transcription;
    }
  }

  async transcribeFile({ file, language } = {}) {
    const config = this.getConfig();
    if (!config.enabled || !config.defaultModel) return { status: "skipped", reason: "disabled" };
    if (!file?.filePath && !file?.realPath) throw new Error("audio file path is required");
    const target = this._resolveTarget(config.defaultModel);
    const result = await this._runAdapter({ target, file, language });
    return {
      status: "ready",
      text: result.text || "",
      providerId: target.providerId,
      modelId: target.model.id,
      protocolId: target.model.protocolId,
      ...(result.language ? { language: result.language } : language ? { language } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    };
  }

  _resolveTarget(defaultModel) {
    const target = this._providers.resolveMediaModel({
      providerId: defaultModel.provider,
      modelId: defaultModel.id,
      capability: CAPABILITY,
    });
    const adapter = this._registry.getProtocol(target.model.protocolId) || this._registry.get(target.providerId);
    if (!adapter?.transcribe) throw new Error(`No speech recognition adapter registered for protocol "${target.model.protocolId}"`);
    return { ...target, adapter };
  }

  async _runAdapter({ target, file, language }) {
    const credentialProviderId = target.credentialLane?.providerId || target.providerId;
    const credentials = this._providers.getCredentials(credentialProviderId) || {};
    return target.adapter.transcribe({
      file,
      provider: target.provider,
      model: target.model,
      credentials,
      language,
      fetch: this._fetch,
    });
  }

  _updateTranscription(sessionPath, fileId, transcription) {
    return this._sessionFiles.updateTranscription(fileId, transcription, { sessionPath });
  }

  _emitTranscriptionUpdate(sessionPath, fileId, transcription) {
    this._emitEvent({
      type: "voice_transcription_update",
      sessionPath,
      fileId,
      transcription,
    }, sessionPath);
  }
}

function normalizeSpeechRecognitionConfigPatch(patch, current = {}) {
  const body = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    next.enabled = body.enabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "defaultModel")) {
    const value = body.defaultModel;
    if (value === null || value === undefined) {
      delete next.defaultModel;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const provider = typeof value.provider === "string" ? value.provider.trim() : "";
      const id = typeof value.id === "string" ? value.id.trim() : "";
      if (!provider || !id) throw new Error("speechRecognition.defaultModel requires provider and id");
      next.defaultModel = { provider, id };
    } else {
      throw new Error("speechRecognition.defaultModel must be an object");
    }
  }
  if (!next.enabled) {
    return {
      enabled: false,
      ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
    };
  }
  return {
    enabled: true,
    ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
  };
}
