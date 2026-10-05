import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// saveImage writes to disk — mock it out so tests stay pure
vi.mock("../plugins/image-gen/lib/download.js", () => ({
  saveImage: vi.fn(async (_buf, _mime, _dir, customName) => {
    const filename = customName ? `${customName}-abc.png` : `1234-abc.png`;
    return { filename, filePath: `/tmp/generated/${filename}` };
  }),
}));

function makeBusCtx(apiKey, baseUrl, providerId = "volcengine") {
  return {
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:credentials" && payload.providerId === providerId) {
          return { apiKey, baseUrl };
        }
        return { error: "not_found" };
      }),
    },
    config: {
      get: vi.fn((key) => {
        if (key === "providerDefaults") return {};
        return null;
      }),
    },
    dataDir: "/tmp/test-data",
    log: vi.fn(),
  };
}

describe("volcengine adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends correct request and returns files from b64_json", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ b64_json: fakeB64, size: "2048x2048" }],
      }),
    });

    const ctx = makeBusCtx("test-key", "https://ark.cn-beijing.volces.com/api/v3");
    const result = await volcengineImageAdapter.submit({
      prompt: "a cat",
      model: "doubao-seedream-4-0-250828",
      size: "2K",
      format: "png",
    }, ctx);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("doubao-seedream-4-0-250828");
    expect(body.prompt).toBe("a cat");
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("2K");
    expect(body.output_format).toBe("png");

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
    expect(result.taskId.length).toBeGreaterThan(0);
  });

  it("resolves Volcengine short image model aliases before submit", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("test-key", "https://ark.cn-beijing.volces.com/api/v3");
    await volcengineImageAdapter.submit({
      prompt: "a cat",
      model: "5.0-lite",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("doubao-seedream-5-0-lite-260128");
  });

  it("maps ratio plus resolution tier to Volcengine pixel size", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("test-key", "https://ark.cn-beijing.volces.com/api/v3");
    await volcengineImageAdapter.submit({
      prompt: "wide city",
      model: "doubao-seedream-4-0-250828",
      ratio: "16:9",
      resolution: "4K",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe("4096x2304");
  });

  it("prefers volcengine-coding credentials for volcengine-coding requests", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("fake-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "volcengine-coding") {
        return { apiKey: "coding-key", baseUrl: "https://coding.example/v1" };
      }
      if (type === "provider:credentials" && payload.providerId === "volcengine") {
        return { apiKey: "plain-key", baseUrl: "https://plain.example/v1" };
      }
      return { error: "not_found" };
    });
    const ctx = {
      bus: { request },
      config: { get: vi.fn(() => ({})) },
      dataDir: "/tmp/test-data",
      log: vi.fn(),
    };

    await volcengineImageAdapter.submit({
      prompt: "coding image",
      providerId: "volcengine-coding",
      model: "doubao-seedream-4-0-250828",
    }, ctx);

    expect(request.mock.calls[0][1].providerId).toBe("volcengine-coding");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://coding.example/v1/images/generations");
    expect(opts.headers.Authorization).toBe("Bearer coding-key");
  });

  it("applies providerDefaults (watermark, guidance_scale)", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") return { volcengine: { watermark: true, guidance_scale: 7.5 } };
      return null;
    });

    await volcengineImageAdapter.submit({
      prompt: "test",
      model: "test-model",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.watermark).toBe(true);
    expect(body.guidance_scale).toBe(7.5);
  });

  it("accepts images param for multi-reference Volcengine requests", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    await volcengineImageAdapter.submit({
      prompt: "combine refs",
      model: "test-model",
      images: [
        "data:image/png;base64,QUJD",
        "data:image/png;base64,REVG",
      ],
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.image).toEqual([
      "data:image/png;base64,QUJD",
      "data:image/png;base64,REVG",
    ]);
  });

  it("throws on API error with status and message", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "invalid key" } }),
    });

    const ctx = makeBusCtx("bad", "https://test.com");
    await expect(volcengineImageAdapter.submit({
      prompt: "a cat", model: "test",
    }, ctx)).rejects.toThrow(/401/);
  });

  it("throws when data array is empty", async () => {
    const { volcengineImageAdapter } = await import("../plugins/image-gen/adapters/volcengine.js");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    });

    const ctx = makeBusCtx("key", "https://test.com");
    await expect(volcengineImageAdapter.submit({
      prompt: "test", model: "test",
    }, ctx)).rejects.toThrow();
  });
});

describe("openai adapter", () => {
  beforeEach(() => mockFetch.mockReset());

  it("sends correct request and returns files from b64_json", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    const fakeB64 = Buffer.from("fake-openai-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ b64_json: fakeB64, revised_prompt: "A fluffy dog in a park" }],
      }),
    });

    const ctx = makeBusCtx("sk-test", "https://api.openai.com/v1", "openai");
    const result = await openaiImageAdapter.submit({
      prompt: "a dog",
      model: "gpt-image-1",
      size: "1024x1024",
      quality: "medium",
      format: "png",
    }, ctx);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("gpt-image-1");
    expect(body.prompt).toBe("a dog");
    expect(body.quality).toBe("medium");
    expect(body.n).toBe(1);

    expect(result.files).toHaveLength(1);
    expect(typeof result.taskId).toBe("string");
  });

  it("applies providerDefaults (background)", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") return { openai: { background: "transparent" } };
      return null;
    });

    await openaiImageAdapter.submit({
      prompt: "test",
      model: "gpt-image-1",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.background).toBe("transparent");
  });

  it("resolves OpenAI short image model aliases before submit", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    await openaiImageAdapter.submit({
      prompt: "test",
      model: "mini",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-image-1-mini");
  });

  it("applies OpenAI image provider defaults for size and quality to the request body", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    const fakeB64 = Buffer.from("img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const ctx = makeBusCtx("key", "https://api.openai.com/v1", "openai");
    ctx.config.get = vi.fn((key) => {
      if (key === "providerDefaults") {
        return { openai: { size: "1536x1024", quality: "high", format: "png" } };
      }
      return null;
    });

    await openaiImageAdapter.submit({
      prompt: "poster",
      model: "gpt-image-1",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe("1536x1024");
    expect(body.quality).toBe("high");
    expect(body.output_format).toBe("png");
  });

  it("throws on API error", async () => {
    const { openaiImageAdapter } = await import("../plugins/image-gen/adapters/openai.js");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "rate limit exceeded" } }),
    });

    const ctx = makeBusCtx("key", "https://test.com", "openai");
    await expect(openaiImageAdapter.submit({
      prompt: "test", model: "test",
    }, ctx)).rejects.toThrow(/429/);
  });
});
