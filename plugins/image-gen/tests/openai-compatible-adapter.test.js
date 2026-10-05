import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCompatibleImageAdapter, submitOpenAICompatibleImage } from "../adapters/openai-compatible.js";

const IMAGE_RESPONSE = JSON.stringify({
  data: [{ b64_json: Buffer.from("fake-image-content").toString("base64") }],
});

function createCtx(tmpDir, providerDefaults = {}, modelId = "local-image-model", configOverrides = {}) {
  return {
    dataDir: tmpDir,
    config: {
      get: (key) => {
        if (key === "providerDefaults") return providerDefaults;
        if (Object.prototype.hasOwnProperty.call(configOverrides, key)) return configOverrides[key];
        return {};
      },
    },
    bus: {
      request: vi.fn(async (eventName, payload = {}) => {
        const { providerId, type } = payload;
        if (type === "image") {
          return { models: [{ id: modelId, name: "Local Image Model" }] };
        }
        return {
          providerId,
          apiKey: "",
          baseUrl: "http://127.0.0.1:7860/v1",
          api: "openai-completions",
        };
      }),
    },
  };
}

function forceImagesRoute(defaults = {}, providerId = "local-image") {
  return {
    ...defaults,
    [providerId]: {
      ...(defaults[providerId] || {}),
      imageRoute: "images",
    },
  };
}

describe("submitOpenAICompatibleImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("supports image URLs returned by local openai-compatible services", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-local-"));
    const imageBuffer = Buffer.from("fake-image-content");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ url: "http://127.0.0.1:7860/generated.png" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => imageBuffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createCtx(tmpDir);

    const result = await submitOpenAICompatibleImage(
      { prompt: "a red fox in snow" },
      ctx,
      "local-image",
    );

    expect(result.taskId).toBeTruthy();
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "generated", result.files[0]))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps ratio to OpenAI-compatible size when no provider default is set", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-ratio-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide landscape", ratio: "16:9" },
      createCtx(tmpDir),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("1536x1024");
  });

  it("sets a safe default size when neither ratio nor size is provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-default-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "square icon" },
      createCtx(tmpDir),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("1024x1024");
  });

  it("preserves orientation enum size configured for custom providers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-orientation-default-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "custom provider image" },
      createCtx(tmpDir, forceImagesRoute({ "gptimage2-provider": { size: "landscape" } }, "gptimage2-provider"), "gptimage2"),
      "gptimage2-provider",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("landscape");
  });

  it("routes compact gptimage2 models through chat completions and saves returned base64 images", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-gptimage2-"));
    const chatImage = `data:image/png;base64,${Buffer.from("chat-image-content").toString("base64")}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: `![image](${chatImage})` } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitOpenAICompatibleImage(
      { prompt: "portrait character", ratio: "9:16" },
      createCtx(tmpDir, {}, "gptimage2"),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain("/chat/completions");
    expect(body.model).toBe("gptimage2");
    expect(body.messages[0].content).toContain("portrait character");
    expect(body.messages[0].content).toContain("Aspect ratio: 9:16.");
    expect(body.messages[0].content).toContain("Image size/orientation: portrait.");
    expect(body).not.toHaveProperty("size");
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "generated", result.files[0]))).toBe(true);
  });

  it("does not treat official gpt-image-2 model ids as gptimage2 gateway schema", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-official-gpt-image-2-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "official wide image", ratio: "16:9" },
      createCtx(tmpDir, {}, "gpt-image-2"),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("1536x1024");
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("keeps gptimage2 resolution tier out of the request body by default", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-gptimage2-resolution-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide high resolution image", ratio: "16:9", resolution: "4K" },
      createCtx(tmpDir, forceImagesRoute(), "gptimage2"),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("landscape");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body).not.toHaveProperty("resolution");
  });

  it("maps official gpt-image-2 resolution tiers to flexible OpenAI pixel sizes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-official-gpt-image-2-resolution-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide high resolution image", ratio: "16:9", resolution: "4K" },
      createCtx(tmpDir, forceImagesRoute(), "gpt-image-2"),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("3840x2160");
    expect(body).not.toHaveProperty("resolution");
  });

  it("retries with alternate size schema when provider rejects size", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-size-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "invalid size" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide image", ratio: "16:9" },
      createCtx(tmpDir, forceImagesRoute(), "gptimage2"),
      "local-image",
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.size).toBe("landscape");
    expect(secondBody.size).toBe("16:9");
  });

  it("retries with alternate size schema when provider rejects size in Chinese", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-size-fallback-cn-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "不合法的尺寸" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide image", ratio: "16:9" },
      createCtx(tmpDir, forceImagesRoute(), "gptimage2"),
      "local-image",
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.size).toBe("landscape");
    expect(secondBody.size).toBe("16:9");
  });

  it("retries pixel size schema when provider rejects ratio and orientation sizes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-size-ratio-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "invalid size" } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "invalid size" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide image", ratio: "16:9" },
      createCtx(tmpDir, forceImagesRoute(), "gptimage2"),
      "local-image",
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const thirdBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(firstBody.size).toBe("landscape");
    expect(secondBody.size).toBe("16:9");
    expect(thirdBody.size).toBe("1536x1024");
  });

  it("retries without size when a compatible provider rejects every size schema", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-size-field-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "不合法的size" } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "不合法的size" } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "不合法的size" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide image", ratio: "16:9" },
      createCtx(tmpDir, forceImagesRoute(), "gptimage2"),
      "local-image",
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const thirdBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    const fourthBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(firstBody.size).toBe("landscape");
    expect(secondBody.size).toBe("16:9");
    expect(thirdBody.size).toBe("1536x1024");
    expect(fourthBody).not.toHaveProperty("size");
    expect(fourthBody.aspect_ratio).toBe("16:9");
  });

  it("retries without OpenAI-only optional fields when a compatible provider rejects them", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-optional-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "unknown parameter: output_format" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "simple image", quality: "high" },
      createCtx(tmpDir, { "local-image": { background: "transparent" } }),
      "local-image",
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.output_format).toBe("jpeg");
    expect(firstBody.n).toBe(1);
    expect(firstBody.quality).toBe("high");
    expect(firstBody.background).toBe("transparent");
    expect(secondBody).not.toHaveProperty("n");
    expect(secondBody).not.toHaveProperty("output_format");
    expect(secondBody).not.toHaveProperty("quality");
    expect(secondBody).not.toHaveProperty("background");
  });

  it("retries without gptimage2 optional schema fields when provider rejects them", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-gptimage2-schema-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "unknown parameter: aspect_ratio" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "simple image", ratio: "1:1", resolution: "2K" },
      createCtx(tmpDir, forceImagesRoute(), "gptimage2"),
      "local-image",
    );

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.aspect_ratio).toBe("1:1");
    expect(firstBody).not.toHaveProperty("resolution");
    expect(secondBody).not.toHaveProperty("aspect_ratio");
    expect(secondBody).not.toHaveProperty("n");
    expect(secondBody).not.toHaveProperty("resolution");
    expect(secondBody.size).toBe("square");
  });

  it("can prefer ratio size schema from provider defaults", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-ratio-schema-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "wide image", ratio: "16:9" },
      createCtx(tmpDir, { "ratio-provider": { sizeSchema: "ratio" } }, "custom-image"),
      "ratio-provider",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.size).toBe("16:9");
  });

  it("sends reference images through chat completions for gptimage2 image-to-image", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-gptimage2-i2i-"));
    const chatImage = `data:image/png;base64,${Buffer.from("chat-i2i-content").toString("base64")}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: chatImage } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "restyle image", image: "https://example.test/ref.png" },
      createCtx(tmpDir, {}, "gptimage2"),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain("/chat/completions");
    expect(body.messages[0].content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("restyle image") }),
      { type: "image_url", image_url: { url: "https://example.test/ref.png" } },
    ]);
  });

  it("sends ghssd reference image as images[].image_url with built-in defaults", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghssd-i2i-flat-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      {
        prompt: "edit with reference",
        image: "https://cdn.example.com/ref.png",
        ratio: "9:16",
      },
      createCtx(tmpDir, {}, "gpt-image-2-2k"),
      "ghssd",
    );

    const url = fetchMock.mock.calls[0][0];
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(url).toContain("/images/generations");
    expect(body.images).toEqual([
      { image_url: "https://cdn.example.com/ref.png" },
    ]);
    expect(body.output_format).toBe("png");
    expect(body.quality).toBe("high");
    expect(body).not.toHaveProperty("image");
    expect(body).not.toHaveProperty("image_urls");
  });

  it("sends multiple ghssd reference images in order", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghssd-i2i-multi-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      {
        prompt: "combine references",
        images: [
          "https://cdn.example.com/composition.png",
          "https://cdn.example.com/pose.png",
        ],
        ratio: "9:16",
      },
      createCtx(tmpDir, {}, "gpt-image-2-2k"),
      "ghssd",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.images).toEqual([
      { image_url: "https://cdn.example.com/composition.png" },
      { image_url: "https://cdn.example.com/pose.png" },
    ]);
  });

  it("supports configured nested images[].image_url.url schema", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghssd-i2i-nested-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      {
        prompt: "edit with reference",
        image: "https://cdn.example.com/ref.png",
      },
      createCtx(
        tmpDir,
        { ghssd: { imageRoute: "images", imageInputField: "images[].image_url.url" } },
        "gpt-image-2-2k",
      ),
      "ghssd",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.images).toEqual([
      { image_url: { url: "https://cdn.example.com/ref.png" } },
    ]);
  });

  it("falls back to nested image_url object when flat image_url is rejected", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghssd-i2i-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          error: { message: "Invalid request: images[].image_url is required" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      {
        prompt: "edit with reference",
        image: "https://cdn.example.com/ref.png",
      },
      createCtx(
        tmpDir,
        { ghssd: { imageRoute: "images", imageInputField: "images[].image_url" } },
        "gpt-image-2-2k",
      ),
      "ghssd",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.images).toEqual([
      { image_url: { url: "https://cdn.example.com/ref.png" } },
    ]);
  });

  it("returns provider-scoped async task ids and queries completed task results", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-async-task-"));
    const imageBuffer = Buffer.from("async-image-content");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 200,
          data: [{ status: "submitted", task_id: "task_test_123" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            status: "completed",
            result: { images: [{ url: ["https://example.test/result.png"] }] },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => imageBuffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createCtx(tmpDir, {}, "gptimage2");
    ctx.config.get = (key) => {
      if (key === "providerDefaults") return forceImagesRoute();
      return {};
    };
    const submitResult = await submitOpenAICompatibleImage(
      { prompt: "async image" },
      ctx,
      "local-image",
    );

    expect(submitResult.taskId).toMatch(/^oc_/);
    expect(submitResult.files).toBeUndefined();

    const queryResult = await openaiCompatibleImageAdapter.query(submitResult.taskId, ctx);
    expect(queryResult.status).toBe("success");
    expect(queryResult.files).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "generated", queryResult.files[0]))).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toContain("/tasks/task_test_123");
  });

  it("queries provider task ids returned at the top level and accepts output URL arrays", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-async-top-level-"));
    const imageBuffer = Buffer.from("async-image-content");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: "task_top_456",
          status: "processing",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: "succeeded",
          output: ["https://example.test/result.png"],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => imageBuffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createCtx(tmpDir, forceImagesRoute(), "gptimage2");
    const submitResult = await submitOpenAICompatibleImage(
      { prompt: "async image" },
      ctx,
      "local-image",
    );

    expect(submitResult.taskId).toMatch(/^oc_/);
    const queryResult = await openaiCompatibleImageAdapter.query(submitResult.taskId, ctx);
    expect(queryResult.status).toBe("success");
    expect(queryResult.files).toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toContain("/tasks/task_top_456");
  });

  it("falls back from edits to generations for providers without edits support", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-edits-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: "multipart parse failed" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "edit this", image: "data:image/png;base64,AAA" },
      createCtx(tmpDir),
      "local-image",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/images/edits");
    expect(fetchMock.mock.calls[1][0]).toContain("/images/generations");
  });

  it("falls back from edits to generations when edits return 403 permission errors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-edits-403-fallback-"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: "permission insufficient for image edits" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => IMAGE_RESPONSE,
      });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "edit this", image: "data:image/png;base64,AAA" },
      createCtx(tmpDir),
      "local-image",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/images/edits");
    expect(fetchMock.mock.calls[1][0]).toContain("/images/generations");
    const fallbackBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fallbackBody.image_urls).toEqual(["data:image/png;base64,AAA"]);
    expect(fallbackBody).not.toHaveProperty("image");
  });

  it("ignores a stale GPT-5.5 default image model and uses the configured image model", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-stale-chat-default-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => IMAGE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitOpenAICompatibleImage(
      { prompt: "simple image" },
      createCtx(
        tmpDir,
        {},
        "local-image-model",
        { defaultImageModel: { provider: "local-image", id: "gpt-5.5" } },
      ),
      "local-image",
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("local-image-model");
  });
});
