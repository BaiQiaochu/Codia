// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";

//
// through ctx._mediaGen.registry.  We import the tool fresh each time so
// module-level state doesn't leak between tests.

let execute, name, description, parameters, promptSnippet, promptGuidelines;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../plugins/image-gen/tools/generate-image.js");
  execute = mod.execute;
  name = mod.name;
  description = mod.description;
  parameters = mod.parameters;
  promptSnippet = mod.promptSnippet;
  promptGuidelines = mod.promptGuidelines;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides = {}) {
  return {
    id: "fake-provider",
    types: ["image"],
    checkAuth: vi.fn(async () => ({ ok: true })),
    submit: vi.fn(async () => ({ taskId: "task-001" })),
    ...overrides,
  };
}

function makeMediaGen(adapterOverrides = {}) {
  const adapter = makeAdapter(adapterOverrides);
  const registry = {
    get: vi.fn((id) => (id === adapter.id ? adapter : undefined)),
    getProtocol: vi.fn((id) => (id === "fake-image-protocol" ? adapter : undefined)),
    getDefault: vi.fn((_type) => adapter),
    getByType: vi.fn((_type) => [adapter]),
  };
  const store = {
    add: vi.fn(),
    update: vi.fn(),
  };
  const poller = {
    add: vi.fn(),
    checkNow: vi.fn(async () => {}),
  };
  return { registry, store, poller, adapter };
}

function makeCtx(mediaGen, busOverrides = {}) {
  return {
    _mediaGen: mediaGen,
    dataDir: "/tmp/test-data",
    sessionPath: "/sessions/test.jsonl",
    bus: {
      request: vi.fn(async (type, payload) => {
        const adapterId = mediaGen?.adapter?.id || "fake-provider";
        if (type === "provider:media-providers") {
          return {
            providers: {
              [adapterId]: {
                providerId: adapterId,
                hasCredentials: true,
                models: [{ id: "fake-image-model", protocolId: "fake-image-protocol" }],
              },
            },
          };
        }
        if (type === "provider:resolve-media-model" && payload?.modelId) {
          return {
            providerId: payload.providerId || adapterId,
            modelId: payload.modelId,
            protocolId: "fake-image-protocol",
          };
        }
        return {};
      }),
      ...busOverrides,
    },
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

async function flushBackgroundSubmits() {
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generate-image tool - metadata", () => {
  it("exports correct name and required param", () => {
    expect(name).toBe("generate-image");
    expect(description).toBeTruthy();
    expect(parameters.required).toContain("prompt");
    expect(parameters.properties.images.type).toBe("array");
    expect(parameters.properties.images.items.type).toBe("string");
    expect(parameters.properties.suggestedFilename.type).toBe("string");
  });

  it("tells the model to call the tool for natural image generation requests", () => {
    expect(promptSnippet).toContain("image-gen_generate-image");
    expect(promptSnippet).toMatch(/without requiring a slash command/i);
    expect(promptGuidelines).toContain("draw");
    expect(promptGuidelines).not.toMatch(/video-gen_.*render/);
  });
});

describe("generate-image tool - initialization guard", () => {
  it("returns error text when ctx._mediaGen is missing", async () => {
    const ctx = makeCtx(null);
    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("图片生成插件未初始化");
    expect(result.details.error).toMatchObject({
      code: "not_initialized",
      mediaType: "image",
    });
  });

  it("returns error text when registry is missing from _mediaGen", async () => {
    const ctx = makeCtx({ store: {}, poller: {} });
    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("图片生成插件未初始化");
    expect(result.details.error).toMatchObject({
      code: "not_initialized",
      mediaType: "image",
    });
  });
});

describe("generate-image response delivery", () => {
  it("submits without a sessionPath when response delivery is requested", async () => {
    const mediaGen = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "response-task" })),
    });
    const ctx = {
      ...makeCtx(mediaGen),
      sessionPath: null,
    };

    const result = await execute({
      prompt: "a response icon",
      provider: "fake-provider",
      delivery: { mode: "response" },
    }, ctx);

    expect(result.details.mediaGeneration).toMatchObject({
      kind: "image",
      prompt: "a response icon",
    });
    expect(mediaGen.store.add).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: null,
      deliveryMode: "response",
      delivery: { mode: "response" },
    }));
    expect(ctx.bus.request).not.toHaveBeenCalledWith("deferred:register", expect.anything());
    expect(ctx.bus.request).not.toHaveBeenCalledWith("task:register", expect.anything());
  });
});

describe("generate-image tool - adapter resolution", () => {
  it("returns error when no adapter of that type exists", async () => {
    const { registry, store, poller } = makeMediaGen();
    registry.getByType.mockReturnValue([]);
    registry.getProtocol.mockReturnValue(undefined);
    const ctx = makeCtx({ registry, store, poller }, { request: vi.fn(async () => ({})) });

    const result = await execute({ prompt: "a cat" }, ctx);
    expect(result.content[0].text).toContain("没有可用的图片生成供应商");
    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "image",
    });
  });

  it("returns error when explicit provider not found", async () => {
    const { registry, store, poller } = makeMediaGen();
    registry.get.mockReturnValue(undefined);
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat", provider: "nonexistent" }, ctx);
    expect(result.content[0].text).toContain("没有可用的图片生成供应商");
    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "image",
    });
  });

  it("uses explicit provider via registry.get when provider is specified", async () => {
    const { registry, store, poller, adapter } = makeMediaGen();
    registry.get.mockImplementation((id) => (id === "fake-provider" ? adapter : undefined));
    const ctx = makeCtx({ registry, store, poller }, { request: vi.fn(async () => ({})) });

    await execute({ prompt: "a cat", provider: "fake-provider" }, ctx);
    expect(registry.get).toHaveBeenCalledWith("fake-provider");
  });

  it("returns a missing-model error when no media image model is configured", async () => {
    const { registry, store, poller } = makeMediaGen();
    const ctx = makeCtx({ registry, store, poller }, { request: vi.fn(async () => ({})) });

    const result = await execute({ prompt: "a cat" }, ctx);

    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "image",
    });
    expect(registry.getByType).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });
});

describe("generate-image tool - submit error", () => {
  it("classifies missing image credentials before submitting", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      checkAuth: vi.fn(async () => ({ ok: false, message: 'Provider "openai" has no API key configured.' })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "missing_credentials",
      mediaType: "image",
    });
  });

  it("classifies image provider preflight failures before submitting", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      checkAuth: vi.fn(async () => ({ ok: false, message: "OpenAI image API error 403: forbidden" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "provider_failure",
      mediaType: "image",
    });
  });

  it("returns a pending card and marks the local task failed when background submit throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => { throw new Error("CLI not found"); }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a cat" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(result.content[0].text).toContain("已提交 1 张图片生成");
    expect(result.details.card.route).toMatch(/^\/card\?batch=/);
    expect(poller.add).toHaveBeenCalledWith(taskId);

    await flushBackgroundSubmits();

    expect(store.update).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        status: "failed",
        failReason: "CLI not found",
        submitState: "failed",
      }),
    );
  });
});

describe("generate-image tool - single submit returns card", () => {
  it("returns the iframe card before adapter.submit settles", async () => {
    let resolveSubmit;
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(() => new Promise((resolve) => {
        resolveSubmit = resolve;
      })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const resultPromise = execute({ prompt: "a slow moon" }, ctx);
    const returnedImmediately = await Promise.race([
      resultPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
    ]);

    expect(returnedImmediately).toBe(true);
    const result = await resultPromise;
    const taskId = store.add.mock.calls[0][0].taskId;

    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(result.details.card.route).toMatch(/^\/card\?batch=/);
    expect(poller.add).toHaveBeenCalledWith(taskId);
    expect(store.update).not.toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ files: ["generated.png"] }),
    );

    resolveSubmit({ taskId: "remote-task-1", files: ["generated.png"] });
    await flushBackgroundSubmits();

    expect(store.update).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        adapterTaskId: "remote-task-1",
        files: ["generated.png"],
        submitState: "submitted",
      }),
    );
    expect(poller.checkNow).toHaveBeenCalledWith(taskId);
  });

  it("returns iframe card on successful single submit", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-abc" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "a sunset" }, ctx);

    expect(result.content[0].text).toContain("已提交 1 张图片生成");
    expect(result.details.card.type).toBe("iframe");
    expect(result.details.card.route).toMatch(/^\/card\?batch=/);
    expect(result.details.card.title).toBe("图片生成");
    expect(result.details.card.description).toContain("a sunset");
  });

  it("records task in store", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-store" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "mountains" }, ctx);

    expect(store.add).toHaveBeenCalledOnce();
    const call = store.add.mock.calls[0][0];
    expect(call.taskId).toBeTruthy();
    expect(call.type).toBe("image");
    expect(call.prompt).toBe("mountains");
    expect(call.adapterTaskId).toBeNull();
    expect(call.submitState).toBe("submitting");
  });

  it("registers task with deferred:register", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-deferred" })),
    });
    const busRequest = vi.fn(async (type, payload) => {
      if (type === "provider:media-providers") {
        return {
          providers: {
            "fake-provider": {
              providerId: "fake-provider",
              hasCredentials: true,
              models: [{ id: "fake-image-model", protocolId: "fake-image-protocol" }],
            },
          },
        };
      }
      if (type === "provider:resolve-media-model") {
        return { providerId: "fake-provider", modelId: payload.modelId, protocolId: "fake-image-protocol" };
      }
      return {};
    });
    const ctx = makeCtx({ registry, store, poller }, { request: busRequest });

    await execute({ prompt: "ocean" }, ctx);

    const deferredCall = busRequest.mock.calls.find(([type]) => type === "deferred:register");
    expect(deferredCall).toBeTruthy();
    expect(deferredCall[1].taskId).toBe(store.add.mock.calls[0][0].taskId);
    expect(deferredCall[1].meta.type).toBe("image-generation");
    expect(deferredCall[1].meta.mediaKind).toBe("image");
  });

  it("marks bridge-originated tasks for bridge delivery instead of desktop parent delivery", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-bridge-deferred" })),
    });
    const busRequest = vi.fn(async () => ({}));
    busRequest.mockImplementation(async (type, payload) => {
      if (type === "provider:media-providers") {
        return {
          providers: {
            "fake-provider": {
              providerId: "fake-provider",
              hasCredentials: true,
              models: [{ id: "fake-image-model", protocolId: "fake-image-protocol" }],
            },
          },
        };
      }
      if (type === "provider:resolve-media-model") {
        return { providerId: "fake-provider", modelId: payload.modelId, protocolId: "fake-image-protocol" };
      }
      return {};
    });
    const ctx = {
      ...makeCtx({ registry, store, poller }, { request: busRequest }),
      bridgeContext: {
        isBridgeSession: true,
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@codia",
        agentId: "codia",
        chatType: "dm",
      },
    };

    await execute({ prompt: "ocean" }, ctx);

    const deferredCall = busRequest.mock.calls.find(([type]) => type === "deferred:register");
    expect(deferredCall[1].meta.deliveryTarget).toEqual({
      kind: "bridge",
      platform: "wechat",
      chatId: "wx-user",
      sessionKey: "wx_dm_wx-user@codia",
      agentId: "codia",
      chatType: "dm",
    });
    expect(store.add.mock.calls[0][0].deliveryTarget).toEqual(deferredCall[1].meta.deliveryTarget);
  });

  it("adds task to poller", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-poll" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "forest" }, ctx);

    expect(poller.add).toHaveBeenCalledWith(store.add.mock.calls[0][0].taskId);
  });

  it("updates the local task when background submit returns files", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-files", files: ["img.png"] })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "a bird" }, ctx);
    const taskId = store.add.mock.calls[0][0].taskId;
    await flushBackgroundSubmits();

    expect(store.update).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        adapterTaskId: "t-files",
        files: ["img.png"],
        submitState: "submitted",
      }),
    );
    expect(poller.checkNow).toHaveBeenCalledWith(taskId);
  });

  it("passes suggestedFilename to the adapter as a storage filename hint", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-named", files: ["article-cover.png"] })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "article cover", suggestedFilename: "article-cover" }, ctx);
    await flushBackgroundSubmits();

    expect(adapter.submit).toHaveBeenCalledWith(expect.objectContaining({
      filename: "article-cover",
    }), expect.any(Object));
  });
});

describe("generate-image tool - count=3 concurrent submits", () => {
  it("submits count times and records all tasks", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "stars", count: 3 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(3);
    expect(poller.add).toHaveBeenCalledTimes(3);
    expect(result.content[0].text).toContain("已提交 3 张图片生成");
  });

  it("clamps count to max 4", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "clouds", count: 10 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(4);
  });

  it("clamps count to min 1", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-min" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "waves", count: 0 }, ctx);

    expect(store.add).toHaveBeenCalledTimes(1);
  });

  it("all tasks share the same batchId", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: `t-batch-${++callIndex}` })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "desert", count: 2 }, ctx);

    const batchIds = store.add.mock.calls.map(([arg]) => arg.batchId);
    expect(batchIds[0]).toBe(batchIds[1]);
    expect(batchIds[0]).toBeTruthy();
  });
});

describe("generate-image tool - partial failure handling", () => {
  it("returns placeholders for all requested images and records per-task background failures", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => {
        callIndex++;
        if (callIndex === 2) throw new Error("network error");
        return { taskId: `t-${callIndex}` };
      }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "rain", count: 3 }, ctx);

    expect(result.content[0].text).toContain("已提交 3 张图片生成");
    expect(result.details.card).toBeTruthy();
    expect(store.add).toHaveBeenCalledTimes(3);

    await flushBackgroundSubmits();

    const failedUpdates = store.update.mock.calls.filter(([, patch]) => patch.status === "failed");
    expect(failedUpdates).toHaveLength(1);
    expect(failedUpdates[0][1].failReason).toBe("network error");
  });

  it("returns placeholders even when every background submit later fails", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => { throw new Error("quota exceeded"); }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "snow", count: 2 }, ctx);

    expect(result.content[0].text).toContain("已提交 2 张图片生成");
    expect(result.details.card).toBeTruthy();

    await flushBackgroundSubmits();

    const failedUpdates = store.update.mock.calls.filter(([, patch]) => patch.status === "failed");
    expect(failedUpdates).toHaveLength(2);
    expect(failedUpdates[0][1].failReason).toBe("quota exceeded");
  });

  it("marks a background submit with no provider taskId or files as failed", async () => {
    let callIndex = 0;
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => {
        callIndex++;
        // second call returns no taskId
        return callIndex === 2 ? {} : { taskId: `t-${callIndex}` };
      }),
    });
    const ctx = makeCtx({ registry, store, poller });

    const result = await execute({ prompt: "ice", count: 2 }, ctx);

    expect(result.content[0].text).toContain("已提交 2 张图片生成");

    await flushBackgroundSubmits();

    const failedUpdates = store.update.mock.calls.filter(([, patch]) => patch.status === "failed");
    expect(failedUpdates).toHaveLength(1);
    expect(failedUpdates[0][1].failReason).toContain("returned no taskId or files");
  });
});

describe("generate-image tool - image param (image-to-image)", () => {
  it("passes image param to adapter.submit", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-img2img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "enhance", image: "/path/to/ref.png" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.image).toBe("/path/to/ref.png");
  });

  it("passes ordered images array to adapter.submit for multi-reference image generation", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-multi-img2img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({
      prompt: "put this cloth on this model",
      images: ["/path/to/model.png", "/path/to/cloth.png"],
    }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.images).toEqual(["/path/to/model.png", "/path/to/cloth.png"]);
    expect(submittedParams).not.toHaveProperty("image");
  });

  it("merges images with legacy image param and removes duplicate references", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-merged-img2img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({
      prompt: "combine references",
      images: [" /path/to/model.png ", "/path/to/cloth.png"],
      image: "/path/to/model.png",
    }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.images).toEqual(["/path/to/model.png", "/path/to/cloth.png"]);
    expect(submittedParams).not.toHaveProperty("image");
  });

  it("maps ratio to aspect_ratio and resolution to size for adapter contracts", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-schema" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "wide scene", ratio: "16:9", resolution: "4k" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.ratio).toBe("16:9");
    expect(submittedParams.aspect_ratio).toBe("16:9");
    expect(submittedParams.resolution).toBe("4K");
    expect(submittedParams.size).toBe("4K");
  });

  it("applies model media parameter schema and options before submit", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-media-params" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              "fake-provider": {
                providerId: "fake-provider",
                hasCredentials: true,
                models: [{
                  id: "fake-image-model",
                  protocolId: "fake-image-protocol",
                  modes: [{
                    id: "text2image",
                    defaults: { quality: "standard" },
                    parameterSchema: {
                      type: "object",
                      properties: {
                        ratio: { type: "string", enum: ["1:1", "16:9"] },
                        quality: { type: "string", enum: ["standard", "hd"] },
                        seed: { type: "number" },
                      },
                    },
                  }],
                }],
              },
            },
          };
        }
        if (type === "provider:resolve-media-model") {
          return {
            providerId: "fake-provider",
            modelId: payload.modelId,
            protocolId: "fake-image-protocol",
            model: {
              id: payload.modelId,
              modes: [{
                id: "text2image",
                defaults: { quality: "standard" },
                parameterSchema: {
                  type: "object",
                  properties: {
                    ratio: { type: "string", enum: ["1:1", "16:9"] },
                    quality: { type: "string", enum: ["standard", "hd"] },
                    seed: { type: "number" },
                  },
                },
              }],
            },
          };
        }
        return {};
      }),
    });

    await execute({
      prompt: "wide scene",
      ratio: "16:9",
      options: { seed: 42 },
    }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.mode).toBe("text2image");
    expect(submittedParams.seed).toBe(42);
    expect(submittedParams.resolvedParameters).toMatchObject({
      ratio: "16:9",
      quality: "standard",
      seed: 42,
    });
  });

  it("rejects image requests that exceed selected model reference image limits", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-too-many-refs" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              "fake-provider": {
                providerId: "fake-provider",
                hasCredentials: true,
                models: [{
                  id: "fake-image-model",
                  protocolId: "fake-image-protocol",
                  modes: [{
                    id: "image2image",
                    inputLimits: { referenceImages: { min: 1, max: 1 } },
                  }],
                }],
              },
            },
          };
        }
        if (type === "provider:resolve-media-model") {
          return {
            providerId: "fake-provider",
            modelId: payload.modelId,
            protocolId: "fake-image-protocol",
            model: {
              id: payload.modelId,
              modes: [{
                id: "image2image",
                inputLimits: { referenceImages: { min: 1, max: 1 } },
              }],
            },
          };
        }
        return {};
      }),
    });

    const result = await execute({
      prompt: "combine references",
      images: ["/tmp/a.png", "/tmp/b.png"],
    }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "invalid_parameters",
      mediaType: "image",
    });
    expect(result.content[0].text).toContain("supports at most 1 reference images");
  });

  it("omits image key from params when not provided", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-no-img" })),
    });
    const ctx = makeCtx({ registry, store, poller });

    await execute({ prompt: "landscape" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams).not.toHaveProperty("image");
  });

  it("uses agent-scoped default image model when no explicit model is passed", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      id: "openai-compatible",
      submit: vi.fn(async () => ({ taskId: "t-agent-config" })),
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-agent-scope-"));
    fs.mkdirSync(path.join(tmpDir, "agents", "codia"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "agents", "codia", "config.json"),
      JSON.stringify({ defaultImageModel: { id: "codia-default", provider: "openai-compatible" } }),
      "utf-8",
    );
    const ctx = {
      ...makeCtx({ registry, store, poller }),
      dataDir: tmpDir,
      agentId: "codia",
    };

    await execute({ prompt: "lanterns" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.providerId).toBe("openai-compatible");
    expect(submittedParams.model).toBe("codia-default");
  });

  it("uses configured image model without requiring it as the main chat model", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      id: "sglang",
      submit: vi.fn(async () => ({ taskId: "t-auto-image" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:models-by-type" && payload.type === "image") {
          return { models: [{ provider: "sglang", id: "sd-local", type: "image" }] };
        }
        if (type === "provider:credentials" && payload.providerId === "sglang") {
          return { api: "openai-completions", baseUrl: "http://127.0.0.1:30000/v1" };
        }
        return {};
      }),
    });

    await execute({ prompt: "local image" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.providerId).toBe("sglang");
    expect(submittedParams.model).toBe("sd-local");
  });

  it("routes model-only GPT image requests before stale MiniMax image defaults", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      id: "image2",
      submit: vi.fn(async () => ({ taskId: "t-gptimage2" })),
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-model-only-"));
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ defaultImageModel: { provider: "minimax", id: "image-01" } }),
      "utf-8",
    );
    const ctx = {
      ...makeCtx({ registry, store, poller }, {
        request: vi.fn(async (type, payload) => {
          if (type === "provider:models-by-type" && payload.type === "image") {
            return { models: [{ provider: "image2", id: "gptimage2", type: "image" }] };
          }
          if (type === "provider:credentials" && payload.providerId === "image2") {
            return { api: "openai-completions", apiKey: "sk-test", baseUrl: "https://image2.example/v1" };
          }
          return { error: "no_credentials" };
        }),
      }),
      dataDir: tmpDir,
    };

    await execute({ prompt: "model-only route", model: "gptimage2" }, ctx);

    const [submittedParams] = adapter.submit.mock.calls[0];
    expect(submittedParams.providerId).toBe("image2");
    expect(submittedParams.model).toBe("gptimage2");
  });

  it("does not use implicit image presets when a provider has credentials but no added image model", async () => {
    const { registry, store, poller, adapter } = makeMediaGen({
      id: "openai",
      submit: vi.fn(async () => ({ taskId: "t-known-preset" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:models-by-type") return { models: [] };
        if (type === "provider:catalog") return { providers: [] };
        if (type === "provider:credentials" && payload.providerId === "openai") {
          return {
            api: "openai-completions",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          };
        }
        return { error: "no_credentials" };
      }),
    });

    const result = await execute({ prompt: "preset image" }, ctx);

    expect(adapter.submit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
    expect(result.details.error).toMatchObject({
      code: "missing_model",
      mediaType: "image",
    });
  });
});

describe("generate-image tool - deferred:register failure is non-fatal", () => {
  it("still returns card when deferred:register throws", async () => {
    const { registry, store, poller } = makeMediaGen({
      submit: vi.fn(async () => ({ taskId: "t-deferred-fail" })),
    });
    const ctx = makeCtx({ registry, store, poller }, {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:media-providers") {
          return {
            providers: {
              "fake-provider": {
                providerId: "fake-provider",
                hasCredentials: true,
                models: [{ id: "fake-image-model", protocolId: "fake-image-protocol" }],
              },
            },
          };
        }
        if (type === "provider:resolve-media-model") {
          return { providerId: "fake-provider", modelId: payload.modelId, protocolId: "fake-image-protocol" };
        }
        if (type === "deferred:register") throw new Error("bus unavailable");
        return {};
      }),
    });

    const result = await execute({ prompt: "fire" }, ctx);

    expect(result.content[0].text).toContain("已提交 1 张图片生成");
    expect(result.details.card).toBeTruthy();
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});

describe("generate-image direct route", () => {
  it("submits image tasks directly through image-gen without relying on a chat model tool call", async () => {
    const routeMod = await import("../plugins/image-gen/routes/generate-image.js");
    const adapter = makeAdapter({
      id: "openai-compatible",
      submit: vi.fn(async () => ({ taskId: "image-task-1" })),
    });
    const registry = {
      get: vi.fn((id) => (id === adapter.id ? adapter : undefined)),
      getProtocol: vi.fn((protocolId) => (protocolId === "openai-compatible-images" ? adapter : undefined)),
      getByType: vi.fn(() => [adapter]),
    };
    const store = { add: vi.fn(), update: vi.fn() };
    const poller = { add: vi.fn(), checkNow: vi.fn(async () => {}) };
    const app = new Hono();
    const ctx = {
      ...makeCtx({ registry, store, poller }, {
        request: vi.fn(async (type) => {
          if (type === "provider:media-providers") {
            return {
              providers: {
                "custom-image": {
                  providerId: "custom-image",
                  hasCredentials: true,
                  models: [{ id: "image-pro", protocolId: "openai-compatible-images" }],
                },
              },
            };
          }
          if (type === "provider:resolve-media-model") {
            return {
              providerId: "custom-image",
              modelId: "image-pro",
              protocolId: "openai-compatible-images",
            };
          }
          return {};
        }),
      }),
      agentId: "agent-1",
      pluginId: "image-gen",
    };
    routeMod.default(app, ctx);

    const res = await app.request("/generate-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-codia-Session-Path": ctx.sessionPath,
      },
      body: JSON.stringify({
        prompt: "a glass city at sunrise",
        provider: "custom-image",
        model: "image-pro",
        ratio: "16:9",
        count: 2,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(adapter.submit).toHaveBeenCalledTimes(2);
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({
      prompt: "a glass city at sunrise",
      providerId: "custom-image",
      model: "image-pro",
      ratio: "16:9",
    });
    expect(body.details.card).toMatchObject({
      pluginId: "image-gen",
      type: "iframe",
    });
  });

  it("rejects empty direct image prompts before invoking media generation", async () => {
    const routeMod = await import("../plugins/image-gen/routes/generate-image.js");
    const app = new Hono();
    routeMod.default(app, {
      ...makeCtx({ registry: { getByType: vi.fn(() => []) }, store: { add: vi.fn() }, poller: { add: vi.fn() } }),
      pluginId: "image-gen",
    });

    const res = await app.request("/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "  " }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "prompt is required" });
  });

  it("returns a conflict instead of HTTP 500 when no image model is configured", async () => {
    const routeMod = await import("../plugins/image-gen/routes/generate-image.js");
    const app = new Hono();
    const ctx = {
      ...makeCtx({
        registry: {
          get: vi.fn(() => undefined),
          getProtocol: vi.fn(() => undefined),
          getByType: vi.fn(() => []),
        },
        store: { add: vi.fn() },
        poller: { add: vi.fn() },
      }, {
        request: vi.fn(async (type) => {
          if (type === "provider:media-providers") return { providers: {} };
          if (type === "provider:models-by-type") return { models: [] };
          return {};
        }),
      }),
      pluginId: "image-gen",
    };
    routeMod.default(app, ctx);

    const res = await app.request("/generate-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-codia-Session-Path": ctx.sessionPath,
      },
      body: JSON.stringify({ prompt: "a flower icon" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      details: { error: { code: "missing_model" } },
    });
  });
});
