// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.js";
import { SpeechRecognitionService } from "../core/speech-recognition-service.js";
import { ProviderRegistry } from "../core/provider-registry.js";

function makeProviderRegistry() {
  return {
    getMediaProviders: vi.fn(() => [
      {
        providerId: "mimo",
        displayName: "MiMo",
        authType: "api-key",
        models: [
          { id: "mimo-v2.5-asr", displayName: "MiMo ASR", protocolId: "mimo-chat-completions-asr" },
        ],
      },
      {
        providerId: "ghost",
        displayName: "Ghost",
        authType: "api-key",
        models: [
          { id: "ghost-asr", displayName: "Ghost ASR", protocolId: "ghost-asr" },
        ],
      },
    ]),
    getMediaProviderCredentialStatus: vi.fn((providerId) => ({
      hasCredentials: providerId !== "ghost",
      unavailableReason: providerId === "ghost" ? "no_credentials" : null,
      lanes: [],
    })),
    resolveMediaModel: vi.fn(() => ({
      capability: "speech_recognition",
      providerId: "mimo",
      provider: { id: "mimo", displayName: "MiMo", baseUrl: "https://api.xiaomimimo.com/v1" },
      model: { id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" },
      credentialLane: null,
    })),
    getCredentials: vi.fn(() => ({
      apiKey: "mimo-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
    })),
  };
}

describe("SpeechRecognitionService", () => {
  it("lists only provider models with registered speech adapters", () => {
    const service = new SpeechRecognitionService({
      providerRegistry: makeProviderRegistry(),
      preferences: { getSpeechRecognitionConfig: () => ({ enabled: false }) },
      sessionFiles: new SessionFileRegistry(),
      emitEvent: vi.fn(),
      adapters: [],
    });
    service.registerAdapter({
      id: "mimo",
      protocolId: "mimo-chat-completions-asr",
      types: ["speechRecognition"],
      transcribe: vi.fn(),
    });

    const result = service.listProviders();

    expect(Object.keys(result.providers)).toEqual(["mimo"]);
    expect(result.providers.mimo.models).toEqual([
      expect.objectContaining({
        id: "mimo-v2.5-asr",
        adapterAvailable: true,
      }),
    ]);
  });

  it("lists only API-registered speech models when the registry exposes registered media models", () => {
    const providerRegistry = makeProviderRegistry();
    providerRegistry.getRegisteredMediaModels = vi.fn((providerId) => (
      providerId === "mimo"
        ? [{ id: "mimo-v2.5-asr", displayName: "MiMo ASR", protocolId: "mimo-chat-completions-asr" }]
        : []
    ));
    const service = new SpeechRecognitionService({
      providerRegistry,
      preferences: { getSpeechRecognitionConfig: () => ({ enabled: false }) },
      sessionFiles: new SessionFileRegistry(),
      emitEvent: vi.fn(),
      adapters: [],
    });
    service.registerAdapter({
      id: "mimo",
      protocolId: "mimo-chat-completions-asr",
      types: ["speechRecognition"],
      transcribe: vi.fn(),
    });

    const result = service.listProviders();

    expect(Object.keys(result.providers)).toEqual(["mimo"]);
    expect(result.providers.mimo.models.map((model) => model.id)).toEqual(["mimo-v2.5-asr"]);
    expect(providerRegistry.getRegisteredMediaModels).toHaveBeenCalledWith("mimo", "speech_recognition");
  });

  it("transcribes a voice-input SessionFile and persists pending then ready state", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-speech-service-"));
    try {
      const sessionPath = path.join(tmpDir, "session.jsonl");
      const voicePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(sessionPath, "{}\n");
      fs.writeFileSync(voicePath, "RIFF");
      let now = 1000;
      const sessionFiles = new SessionFileRegistry({ now: () => now });
      const file = sessionFiles.registerFile({
        sessionPath,
        filePath: voicePath,
        label: "voice.wav",
        origin: "voice_input",
        storageKind: "managed_cache",
        presentation: "voice-input",
        listed: false,
      });
      const emitEvent = vi.fn();
      const adapter = {
        id: "mimo",
        protocolId: "mimo-chat-completions-asr",
        types: ["speechRecognition"],
        transcribe: vi.fn(async () => ({ text: "speech input ready", language: "en" })),
      };
      const service = new SpeechRecognitionService({
        providerRegistry: makeProviderRegistry(),
        preferences: {
          getSpeechRecognitionConfig: () => ({
            enabled: true,
            defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
          }),
        },
        sessionFiles,
        emitEvent,
        adapters: [],
      });
      service.registerAdapter(adapter);

      now = 2000;
      const result = await service.transcribeVoiceAttachment({ sessionPath, fileId: file.id });

      expect(result).toMatchObject({ status: "ready", text: "speech input ready" });
      expect(adapter.transcribe).toHaveBeenCalledWith(expect.objectContaining({
        file: expect.objectContaining({ id: file.id, filePath: voicePath }),
        model: expect.objectContaining({ id: "mimo-v2.5-asr" }),
        credentials: expect.objectContaining({ apiKey: "mimo-key" }),
      }));
      expect(sessionFiles.get(file.id, { sessionPath })?.transcription).toMatchObject({
        status: "ready",
        text: "speech input ready",
        providerId: "mimo",
        modelId: "mimo-v2.5-asr",
        protocolId: "mimo-chat-completions-asr",
        language: "en",
      });
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "voice_transcription_update",
        fileId: file.id,
        transcription: expect.objectContaining({ status: "pending" }),
      }), sessionPath);
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "voice_transcription_update",
        fileId: file.id,
        transcription: expect.objectContaining({ status: "ready", text: "speech input ready" }),
      }), sessionPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves MiMo Token Plan STT with Token Plan credentials and base URL", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-speech-token-plan-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
        "providers:",
        "  mimo-token-plan:",
        "    api_key: tp-mimo-key",
        "    base_url: https://token-plan-cn.xiaomimimo.com/v1",
        "    api: openai-completions",
        "",
      ].join("\n"), "utf-8");
      const providerRegistry = new ProviderRegistry(tmpDir);
      providerRegistry.reload();

      const sessionPath = path.join(tmpDir, "session.jsonl");
      const voicePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(sessionPath, "{}\n");
      fs.writeFileSync(voicePath, "RIFF");
      const sessionFiles = new SessionFileRegistry();
      const file = sessionFiles.registerFile({
        sessionPath,
        filePath: voicePath,
        label: "voice.wav",
        origin: "voice_input",
        storageKind: "managed_cache",
        presentation: "voice-input",
        listed: false,
      });
      const adapter = {
        id: "mimo",
        protocolId: "mimo-chat-completions-asr",
        types: ["speechRecognition"],
        transcribe: vi.fn(async () => ({ text: "token plan ready", language: "auto" })),
      };
      const service = new SpeechRecognitionService({
        providerRegistry,
        preferences: {
          getSpeechRecognitionConfig: () => ({
            enabled: true,
            defaultModel: { provider: "mimo-token-plan", id: "mimo-v2.5-asr" },
          }),
        },
        sessionFiles,
        emitEvent: vi.fn(),
        adapters: [],
      });
      service.registerAdapter(adapter);

      const result = await service.transcribeVoiceAttachment({ sessionPath, fileId: file.id });

      expect(result).toMatchObject({
        status: "ready",
        providerId: "mimo-token-plan",
        protocolId: "mimo-chat-completions-asr",
      });
      expect(adapter.transcribe).toHaveBeenCalledWith(expect.objectContaining({
        provider: expect.objectContaining({
          id: "mimo-token-plan",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        }),
        credentials: expect.objectContaining({
          apiKey: "tp-mimo-key",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          api: "openai-completions",
        }),
      }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("logs queued transcription failures instead of swallowing them silently", async () => {
    const warn = vi.fn();
    const service = new SpeechRecognitionService({
      providerRegistry: makeProviderRegistry(),
      preferences: {
        getSpeechRecognitionConfig: () => ({
          enabled: true,
          defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
        }),
      },
      sessionFiles: new SessionFileRegistry(),
      emitEvent: vi.fn(),
      logger: { warn },
      adapters: [],
    });
    service.registerAdapter({
      id: "mimo",
      protocolId: "mimo-chat-completions-asr",
      types: ["speechRecognition"],
      transcribe: vi.fn(),
    });

    await service.queueVoiceTranscription({ sessionPath: "/tmp/missing.jsonl", fileId: "sf_missing" });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sf_missing"));
  });
});
