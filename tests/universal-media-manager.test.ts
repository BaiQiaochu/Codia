import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { UniversalMediaManager } from "../core/media/universal-media-manager.ts";
import { resolveMediaParameters } from "../core/media/media-parameters.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-universal-media-"));
}

function writeLegacyImageConfig(root, global) {
  const dir = path.join(root, "plugin-data", "image-gen");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    schemaVersion: 1,
    global,
    agents: {},
    sessions: {},
  }, null, 2));
}

function makePreferences(root, initial: any = null) {
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  if (initial) {
    fs.writeFileSync(path.join(userDir, "preferences.json"), JSON.stringify(initial, null, 2));
  }
  return new PreferencesManager({ userDir, agentsDir });
}

function makeManager(root, preferences, extra: any = {}) {
  return new UniversalMediaManager({
    gsapHome: root,
    preferences,
    sessionFiles: extra.sessionFiles,
    providerRegistry: {
      getMediaProviders: () => [],
      resolveMediaModel: () => {
        throw new Error("not configured");
      },
    },
    registerSessionFile: () => {},
  });
}

function makeSessionPath(root, name = "session.jsonl") {
  const dir = path.join(root, "agents", "gsap", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, name);
  fs.writeFileSync(sessionPath, "{}\n");
  return sessionPath;
}

function makeTempFile(root, name, content = "bytes") {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function makeBus() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((type, handler) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
    subscribe: vi.fn(() => () => {}),
    request: vi.fn(async () => ({})),
    emit: vi.fn(),
  };
}

async function flushBackgroundWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("UniversalMediaManager image config migration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges legacy image-gen config into native preferences before native config shadows it", () => {
    const root = makeRoot();
    roots.push(root);
    writeLegacyImageConfig(root, {
      defaultImageModel: { provider: "legacy-provider", id: "legacy-model" },
      providerDefaults: {
        openai: { quality: "high" },
        dashscope: { watermark: false },
      },
    });
    const preferences = makePreferences(root, {
      imageGeneration: {
        defaultImageModel: { provider: "native-provider", id: "native-model" },
        providerDefaults: {
          openai: { size: "1024x1024" },
        },
      },
    });

    const manager = makeManager(root, preferences);

    expect(manager.getImageConfig()).toEqual({
      defaultImageModel: { provider: "native-provider", id: "native-model" },
      providerDefaults: {
        openai: { quality: "high", size: "1024x1024" },
        dashscope: { watermark: false },
      },
    });
    expect(preferences.getPreferences()).toMatchObject({
      _imageGenerationLegacyConfigMigrated: true,
      imageGeneration: {
        defaultImageModel: { provider: "native-provider", id: "native-model" },
        providerDefaults: {
          openai: { quality: "high", size: "1024x1024" },
          dashscope: { watermark: false },
        },
      },
    });
  });

  it("does not resurrect legacy defaults after migration has been marked", () => {
    const root = makeRoot();
    roots.push(root);
    writeLegacyImageConfig(root, {
      defaultImageModel: { provider: "legacy-provider", id: "legacy-model" },
      providerDefaults: { openai: { quality: "high" } },
    });
    const preferences = makePreferences(root);
    const manager = makeManager(root, preferences);

    manager.setImageConfig({ defaultImageModel: undefined });

    expect(manager.getImageConfig()).toEqual({
      providerDefaults: { openai: { quality: "high" } },
    });
    expect(preferences.getPreferences()).toMatchObject({
      _imageGenerationLegacyConfigMigrated: true,
      imageGeneration: {
        providerDefaults: { openai: { quality: "high" } },
      },
    });
  });
});

describe("UniversalMediaManager plugin image input boundary", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves plugin referenceImages through session-owned SessionFile records", async () => {
    const root = makeRoot();
    roots.push(root);
    const preferences = makePreferences(root);
    const sessionFiles = new SessionFileRegistry();
    const sessionPath = makeSessionPath(root, "image-session.jsonl");
    const imagePath = makeTempFile(root, "refs/cover.png", "png");
    const image = sessionFiles.registerFile({
      sessionPath,
      filePath: imagePath,
      origin: "user_upload",
      storageKind: "managed_cache",
    });
    const manager = makeManager(root, preferences, { sessionFiles });
    (manager as any).submitImage = async (payload) => ({
      ok: true,
      input: payload.input,
      sessionPath: payload.sessionPath,
    });

    const result = await manager.generateImageFromBus({
      sessionPath,
      prompt: "draw",
      referenceImages: [{ kind: "session_file", fileId: image.id }],
    });

    expect(result).toMatchObject({
      ok: true,
      sessionPath,
      input: {
        prompt: "draw",
        referenceImages: [imagePath],
        image: [imagePath],
      },
    });
  });

  it("rejects plugin referenceImages that are raw strings instead of SessionFile references", async () => {
    const root = makeRoot();
    roots.push(root);
    const manager = makeManager(root, makePreferences(root), {
      sessionFiles: new SessionFileRegistry(),
    });
    (manager as any).submitImage = async () => {
      throw new Error("submitImage should not run for invalid references");
    };

    await expect(manager.generateImageFromBus({
      sessionPath: makeSessionPath(root, "unsafe-image-session.jsonl"),
      prompt: "draw",
      referenceImages: ["/tmp/private.png"],
    })).rejects.toThrow(/session_file/);
  });

  it("submits resolved SessionFile referenceImages to the adapter on the real image path", async () => {
    const root = makeRoot();
    roots.push(root);
    const sessionFiles = new SessionFileRegistry();
    const sessionPath = makeSessionPath(root, "real-submit-image-session.jsonl");
    const imageA = makeTempFile(root, "refs/a.png", "png-a");
    const imageB = makeTempFile(root, "refs/b.png", "png-b");
    const refA = sessionFiles.registerFile({
      sessionPath,
      filePath: imageA,
      origin: "user_upload",
      storageKind: "managed_cache",
    });
    const refB = sessionFiles.registerFile({
      sessionPath,
      filePath: imageB,
      origin: "user_upload",
      storageKind: "managed_cache",
    });
    const manager = makeManager(root, makePreferences(root), { sessionFiles });
    const bus = makeBus();
    manager.start(bus);
    const submit = vi.fn(async () => ({ taskId: "remote-image-task" }));
    manager.registerAdapter({
      id: "real-image",
      types: ["image"],
      submit,
    });

    await manager.generateImageFromBus({
      sessionPath,
      prompt: "draw from refs",
      provider: "real-image",
      referenceImages: [
        { kind: "session_file", fileId: refA.id },
        { kind: "session_file", fileId: refB.id },
      ],
    });
    await flushBackgroundWork();

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        image: [imageA, imageB],
      }),
      expect.anything(),
    );

    manager.stop();
  });
});

describe("media parameter input limits", () => {
  it("lets explicit image resolution override a provider default size", () => {
    const result = resolveMediaParameters({
      kind: "image",
      providerId: "openai-codex-oauth",
      input: {
        prompt: "a classroom cover",
        resolution: "2k",
        ratio: "16:9",
      },
      providerDefaults: {
        size: "4K",
      },
      model: {
        id: "gpt-image-2",
        parameterSchema: { type: "object", properties: {} },
      },
    });

    expect(result.resolvedParameters).toMatchObject({
      resolution: "2k",
      ratio: "16:9",
    });
    expect(result.resolvedParameters).not.toHaveProperty("size");
  });

  it("rejects image resolution values outside the selected mode schema instead of falling back", () => {
    expect(() => resolveMediaParameters({
      kind: "image",
      providerId: "openai-codex-oauth",
      input: {
        prompt: "a classroom cover",
        resolution: "4K",
        ratio: "3:2",
      },
      model: {
        id: "gpt-image-2",
        modes: [{
          id: "text2image",
          parameterSchema: {
            type: "object",
            properties: {
              resolution: { type: "string", enum: ["1K", "2K"], default: "2K" },
              ratio: { type: "string", enum: ["1:1", "3:2"], default: "3:2" },
            },
          },
          defaults: { resolution: "2K", ratio: "3:2" },
        }],
      },
    })).toThrow(/resolution.*1K, 2K/);
  });

  it("rejects reference images when the selected model mode is text-only", () => {
    expect(() => resolveMediaParameters({
      kind: "image",
      providerId: "openai",
      input: {
        mode: "text2image",
        image: ["https://example.com/ref.png"],
      },
      model: {
        id: "dall-e-3",
        modes: [{
          id: "text2image",
          inputLimits: { referenceImages: { min: 0, max: 0 } },
          parameterSchema: { type: "object", properties: {} },
        }],
      },
    })).toThrow(/reference images/);
  });

  it("rejects too many reference images for the selected model mode", () => {
    expect(() => resolveMediaParameters({
      kind: "image",
      providerId: "gemini",
      input: {
        image: [
          "https://example.com/a.png",
          "https://example.com/b.png",
          "https://example.com/c.png",
          "https://example.com/d.png",
        ],
      },
      model: {
        id: "gemini-2.5-flash-image",
        modes: [{
          id: "image2image",
          inputLimits: { referenceImages: { min: 1, max: 3 } },
          parameterSchema: { type: "object", properties: {} },
        }],
      },
    })).toThrow(/at most 3 reference images/);
  });
});

describe("UniversalMediaManager adapter registration bus contract", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers the shared image-gen built-in adapter list in the native media runtime", async () => {
    const root = makeRoot();
    roots.push(root);
    const { builtinImageGenAdapters } = await import("../plugins/image-gen/builtin-adapters.ts");
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root),
      providerRegistry: {
        getMediaProviders: () => [],
        resolveMediaModel: () => {
          throw new Error("not configured");
        },
      },
      registerSessionFile: () => {},
    });

    const expectedIds = builtinImageGenAdapters.map((adapter) => adapter.id).sort();
    const actualIds = manager.registry.list().map((adapter) => adapter.id).sort();
    expect(actualIds).toEqual(expectedIds);
  });

  it("accepts module loggers that expose log/warn/error but no info method", () => {
    const root = makeRoot();
    roots.push(root);
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root),
      providerRegistry: {
        getMediaProviders: () => [],
        resolveMediaModel: () => {
          throw new Error("not configured");
        },
      },
      registerSessionFile: () => {},
      logger: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    const bus = makeBus();
    manager.start(bus);

    const result = bus.handlers.get("media-gen:register-adapter")({
      adapter: {
        id: "jimeng-cli-images",
        protocolId: "jimeng-cli-images",
        types: ["image"],
        submit: vi.fn(),
      },
    });
    expect(result).toEqual({ ok: true });
    expect(manager.registry.getProtocol("jimeng-cli-images")).toMatchObject({
      id: "jimeng-cli-images",
    });

    manager.stop();
  });

  it("keeps adapter registration independent from logger failures", () => {
    const root = makeRoot();
    roots.push(root);
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root),
      providerRegistry: {
        getMediaProviders: () => [],
        resolveMediaModel: () => {
          throw new Error("not configured");
        },
      },
      registerSessionFile: () => {},
      logger: {
        info: vi.fn(() => {
          throw new Error("logger failed");
        }),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    const bus = makeBus();
    manager.start(bus);

    expect(() => bus.handlers.get("media-gen:register-adapter")({
      adapter: {
        id: "jimeng-cli-images",
        protocolId: "jimeng-cli-images",
        types: ["image"],
        submit: vi.fn(),
      },
    })).not.toThrow();
    expect(manager.registry.getProtocol("jimeng-cli-images")).toMatchObject({
      id: "jimeng-cli-images",
    });

    manager.stop();
  });
});

describe("UniversalMediaManager response delivery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("submits image generation without a sessionPath when delivery mode is response", async () => {
    const root = makeRoot();
    roots.push(root);
    const manager = makeManager(root, makePreferences(root));
    const bus = makeBus();
    manager.start(bus);
    manager.registerAdapter({
      id: "response-image",
      types: ["image"],
      submit: vi.fn(async () => ({ taskId: "remote-image-task" })),
    });

    const result = await manager.generateImageFromBus({
      prompt: "draw without a session",
      provider: "response-image",
      delivery: { mode: "response" },
    });

    expect(result).toMatchObject({
      ok: true,
      kind: "image",
      delivery: { mode: "response" },
    });
    expect(manager.getTask(result.tasks[0].taskId)).toMatchObject({
      sessionPath: null,
      deliveryMode: "response",
    });
    expect(bus.request).not.toHaveBeenCalledWith("deferred:register", expect.anything());
    expect(bus.request).not.toHaveBeenCalledWith("task:register", expect.anything());

    manager.stop();
  });

  it("submits video generation without a sessionPath when delivery mode is response", async () => {
    const root = makeRoot();
    roots.push(root);
    const manager = makeManager(root, makePreferences(root));
    const bus = makeBus();
    manager.start(bus);
    manager.registerAdapter({
      id: "response-video",
      types: ["video"],
      submit: vi.fn(async () => ({ taskId: "video-task" })),
    });

    const result = await manager.generateVideoFromBus({
      prompt: "animate without a session",
      provider: "response-video",
      delivery: { mode: "response" },
    });

    expect(result).toMatchObject({
      ok: true,
      kind: "video",
      delivery: { mode: "response" },
      tasks: [{ taskId: "video-task" }],
    });
    expect(manager.getTask("video-task")).toMatchObject({
      sessionPath: null,
      deliveryMode: "response",
    });
    expect(bus.request).not.toHaveBeenCalledWith("deferred:register", expect.anything());
    expect(bus.request).not.toHaveBeenCalledWith("task:register", expect.anything());

    manager.stop();
  });

  it("resolves explicit video provider and model through media capabilities before selecting an adapter", async () => {
    const root = makeRoot();
    roots.push(root);
    const providerRegistry = {
      getMediaProviders: () => [],
      resolveMediaModel: vi.fn(() => ({
        providerId: "agnes",
        model: { id: "agnes-video-v2.0", protocolId: "agnes-videos" },
        credentialLane: null,
      })),
    };
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root),
      providerRegistry,
      registerSessionFile: () => {},
    });
    const bus = makeBus();
    manager.start(bus);
    const submit = vi.fn(async () => ({ taskId: "agnes-video-task", providerTaskId: "provider-task" }));
    manager.registerAdapter({
      id: "agnes",
      protocolId: "agnes-videos",
      types: ["video"],
      submit,
    });

    const result = await manager.generateVideoFromBus({
      prompt: "animate a quiet desk",
      provider: "agnes",
      model: "agnes-video-v2.0",
      delivery: { mode: "response" },
    });

    expect(providerRegistry.resolveMediaModel).toHaveBeenCalledWith({
      providerId: "agnes",
      modelId: "agnes-video-v2.0",
      capability: "video_generation",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "agnes",
        modelId: "agnes-video-v2.0",
        protocolId: "agnes-videos",
        credentialProviderId: "agnes",
      }),
      expect.any(Object),
    );
    expect(result.tasks).toEqual([{ taskId: "agnes-video-task" }]);
    expect(manager.getTask("agnes-video-task")).toMatchObject({
      providerId: "agnes",
      modelId: "agnes-video-v2.0",
      protocolId: "agnes-videos",
      adapterTaskId: "provider-task",
    });

    manager.stop();
  });

  it("uses the default video model config when no video provider is specified", async () => {
    const root = makeRoot();
    roots.push(root);
    const providerRegistry = {
      getMediaProviders: () => [],
      resolveMediaModel: vi.fn(() => ({
        providerId: "agnes",
        model: { id: "agnes-video-v2.0", protocolId: "agnes-videos" },
        credentialLane: null,
      })),
    };
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root, {
        videoGeneration: {
          defaultVideoModel: { provider: "agnes", id: "agnes-video-v2.0" },
        },
      }),
      providerRegistry,
      registerSessionFile: () => {},
    });
    const bus = makeBus();
    manager.start(bus);
    const submit = vi.fn(async () => ({ taskId: "agnes-video-task", providerTaskId: "video-provider-task" }));
    manager.registerAdapter({
      id: "agnes-videos",
      protocolId: "agnes-videos",
      types: ["video"],
      submit,
    });

    await manager.generateVideoFromBus({
      prompt: "animate a quiet desk",
      delivery: { mode: "response" },
    });

    expect(providerRegistry.resolveMediaModel).toHaveBeenCalledWith({
      providerId: "agnes",
      modelId: "agnes-video-v2.0",
      capability: "video_generation",
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "agnes",
        modelId: "agnes-video-v2.0",
        credentialProviderId: "agnes",
      }),
      expect.any(Object),
    );

    manager.stop();
  });

  it("preserves provider-contributed video parameter schemas for settings and discovery", async () => {
    const root = makeRoot();
    roots.push(root);
    const parameterSchema = {
      type: "object",
      properties: {
        duration: { type: "number", minimum: 4, maximum: 15, default: 5 },
        video_resolution: { type: "string", enum: ["720p", "1080p"], default: "720p" },
      },
    };
    const providerRegistry = {
      getMediaProviders: () => [{
        providerId: "jimeng-cli",
        displayName: "Jimeng CLI",
        models: [{
          id: "seedance2.0_vip",
          displayName: "Seedance 2.0 VIP",
          protocolId: "jimeng-cli-videos",
          modes: [{
            id: "text2video",
            label: "Text to video",
            parameterSchema,
            defaults: { duration: 5, video_resolution: "720p" },
          }],
        }],
      }],
      getMediaProviderCredentialStatus: () => ({
        hasCredentials: true,
        unavailableReason: null,
        lanes: [],
      }),
      resolveMediaModel: () => {
        throw new Error("not used");
      },
    };
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root),
      providerRegistry,
      registerSessionFile: () => {},
    });
    manager.registerAdapter({
      id: "jimeng-cli-videos",
      protocolId: "jimeng-cli-videos",
      types: ["video"],
      submit: vi.fn(),
    });

    await expect(manager.listVideoProviders()).resolves.toMatchObject({
      providers: {
        "jimeng-cli": {
          models: [expect.objectContaining({
            id: "seedance2.0_vip",
            modes: [expect.objectContaining({
              id: "text2video",
              parameterSchema,
              defaults: { duration: 5, video_resolution: "720p" },
            })],
          })],
        },
      },
    });
  });

  it("merges video model defaults, user defaults, and request options before adapter submit", async () => {
    const root = makeRoot();
    roots.push(root);
    const providerRegistry = {
      getMediaProviders: () => [],
      resolveMediaModel: vi.fn(() => ({
        providerId: "jimeng-cli",
        model: {
          id: "seedance2.0_vip",
          protocolId: "jimeng-cli-videos",
          modes: [{
            id: "text2video",
            defaults: { duration: 5, ratio: "16:9", video_resolution: "720p" },
            parameterSchema: {
              type: "object",
              properties: {
                duration: { type: "number", minimum: 4, maximum: 15 },
                ratio: { type: "string", enum: ["16:9", "9:16"] },
                video_resolution: { type: "string", enum: ["720p", "1080p"] },
              },
            },
          }],
        },
        credentialLane: null,
      })),
    };
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root, {
        videoGeneration: {
          defaultVideoModel: { provider: "jimeng-cli", id: "seedance2.0_vip" },
          providerDefaults: {
            "jimeng-cli": {
              duration: 7,
              options: { video_resolution: "1080p" },
            },
          },
        },
      }),
      providerRegistry,
      registerSessionFile: () => {},
    });
    const bus = makeBus();
    manager.start(bus);
    const submit = vi.fn(async () => ({ taskId: "jimeng-video-task" }));
    manager.registerAdapter({
      id: "jimeng-cli-videos",
      protocolId: "jimeng-cli-videos",
      types: ["video"],
      submit,
    });

    await manager.generateVideoFromBus({
      prompt: "rainy street, slow camera push",
      delivery: { mode: "response" },
      options: { ratio: "9:16" },
    });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "jimeng-cli",
        modelId: "seedance2.0_vip",
        mode: "text2video",
        duration: 7,
        ratio: "9:16",
        video_resolution: "1080p",
        resolvedParameters: expect.objectContaining({
          duration: 7,
          ratio: "9:16",
          video_resolution: "1080p",
        }),
      }),
      expect.any(Object),
    );
    expect(manager.getTask("jimeng-video-task")).toMatchObject({
      params: expect.objectContaining({
        resolvedParameters: expect.objectContaining({
          duration: 7,
          ratio: "9:16",
          video_resolution: "1080p",
        }),
      }),
    });

    manager.stop();
  });

  it("rejects video options outside the selected model mode schema", async () => {
    const root = makeRoot();
    roots.push(root);
    const providerRegistry = {
      getMediaProviders: () => [],
      resolveMediaModel: vi.fn(() => ({
        providerId: "jimeng-cli",
        model: {
          id: "seedance2.0fast",
          protocolId: "jimeng-cli-videos",
          modes: [{
            id: "text2video",
            parameterSchema: {
              type: "object",
              properties: {
                video_resolution: { type: "string", enum: ["720p"] },
              },
            },
          }],
        },
        credentialLane: null,
      })),
    };
    const manager = new UniversalMediaManager({
      gsapHome: root,
      preferences: makePreferences(root, {
        videoGeneration: {
          defaultVideoModel: { provider: "jimeng-cli", id: "seedance2.0fast" },
        },
      }),
      providerRegistry,
      registerSessionFile: () => {},
    });
    manager.start(makeBus());
    const submit = vi.fn(async () => ({ taskId: "should-not-submit" }));
    manager.registerAdapter({
      id: "jimeng-cli-videos",
      protocolId: "jimeng-cli-videos",
      types: ["video"],
      submit,
    });

    await expect(manager.generateVideoFromBus({
      prompt: "rainy street",
      delivery: { mode: "response" },
      options: { video_resolution: "1080p" },
    })).rejects.toThrow(/video_resolution/);
    expect(submit).not.toHaveBeenCalled();

    manager.stop();
  });

  it("resolves video reference images through session-owned SessionFile records", async () => {
    const root = makeRoot();
    roots.push(root);
    const sessionFiles = new SessionFileRegistry();
    const sessionPath = makeSessionPath(root, "video-session.jsonl");
    const imagePath = makeTempFile(root, "refs/video-cover.png", "png");
    const image = sessionFiles.registerFile({
      sessionPath,
      filePath: imagePath,
      origin: "user_upload",
      storageKind: "managed_cache",
    });
    const manager = makeManager(root, makePreferences(root), { sessionFiles });
    (manager as any).submitVideo = async (payload) => ({
      ok: true,
      input: payload.input,
      sessionPath: payload.sessionPath,
    });

    const result = await manager.generateVideoFromBus({
      sessionPath,
      prompt: "animate from ref",
      referenceImages: [{ kind: "session_file", fileId: image.id }],
    });

    expect(result).toMatchObject({
      ok: true,
      sessionPath,
      input: {
        prompt: "animate from ref",
        referenceImages: [imagePath],
        image: [imagePath],
      },
    });
  });
});
