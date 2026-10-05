import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../plugins/image-gen/lib/download.js", () => ({
  saveMedia: vi.fn(async (_buf, _mime, _dir, customName) => ({
    filename: `${customName}-saved.mp4`,
    filePath: `/tmp/generated/${customName}-saved.mp4`,
  })),
}));

let volcengineVideoAdapter;
let tempDirs = [];

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  ({ volcengineVideoAdapter } = await import("../plugins/image-gen/adapters/volcengine-video.js"));
});

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-volcvideo-"));
  tempDirs.push(dir);
  const file = path.join(dir, "ref.png");
  fs.writeFileSync(file, Buffer.from("png"));
  return file;
}

function makeCtx({ apiKey = "key", baseUrl = "https://ark.test/api/v3", providerId = "volcengine", defaults = {}, defaultVideoModel = null } = {}) {
  return {
    dataDir: "/tmp/data",
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
        if (key === "providerDefaults") return defaults;
        if (key === "defaultVideoModel") return defaultVideoModel;
        return null;
      }),
    },
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function mediaResponse() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from("video").buffer,
    headers: { get: () => "video/mp4" },
  };
}

describe("volcengine video adapter", () => {
  it("probes the models endpoint when checking auth", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const ctx = makeCtx();

    await expect(volcengineVideoAdapter.checkAuth(ctx)).resolves.toEqual({ ok: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ark.test/api/v3/models");
    expect(opts.method).toBe("GET");
    expect(opts.body).toBeUndefined();
    expect(url).not.toContain("/contents/generations/tasks");
  });

  it("submits a Seedance task with defaults and local image data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "remote/task:1" }));
    const imagePath = makeTempImage();
    const ctx = makeCtx({
      defaults: {
        volcengine: { videoDuration: "10", generateAudio: true, watermark: true, ratio: "16:9" },
      },
      defaultVideoModel: { provider: "volcengine", id: "seedance-default" },
    });

    const result = await volcengineVideoAdapter.submit({
      prompt: "city timelapse",
      providerId: "volcengine",
      image: imagePath,
    }, ctx);

    expect(result.taskId).toMatch(/^volcvideo_/);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ark.test/api/v3/contents/generations/tasks");
    expect(opts.headers.Authorization).toBe("Bearer key");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      model: "seedance-default",
      generate_audio: true,
      watermark: true,
      ratio: "16:9",
      duration: 10,
    });
    expect(body.content[0]).toEqual({ type: "text", text: "city timelapse" });
    expect(body.content[1].type).toBe("image_url");
    expect(body.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("accepts images param for ordered multi-reference video content", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "remote/task:refs" }));
    const imagePath = makeTempImage();
    const ctx = makeCtx();

    await volcengineVideoAdapter.submit({
      prompt: "animate references",
      providerId: "volcengine",
      images: [imagePath, "https://cdn.example.test/ref.png"],
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content[0]).toEqual({ type: "text", text: "animate references" });
    expect(body.content[1].type).toBe("image_url");
    expect(body.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.content[2]).toEqual({
      type: "image_url",
      image_url: { url: "https://cdn.example.test/ref.png" },
    });
  });

  it("accepts a 15 second default duration and forwards it to the request body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "remote/task:15s" }));
    const ctx = makeCtx({
      defaults: {
        volcengine: { videoDuration: "15", ratio: "16:9" },
      },
    });

    await volcengineVideoAdapter.submit({
      prompt: "night traffic",
      providerId: "volcengine",
    }, ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.duration).toBe(15);
  });

  it("prefers volcengine-coding credentials for coding provider requests", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { task_id: "coding-remote" } }));
    const request = vi.fn(async (type, payload) => {
      if (type === "provider:credentials" && payload.providerId === "volcengine-coding") {
        return { apiKey: "coding-key", baseUrl: "https://coding.test/v1" };
      }
      if (type === "provider:credentials" && payload.providerId === "volcengine") {
        return { apiKey: "plain-key", baseUrl: "https://plain.test/v1" };
      }
      return { error: "not_found" };
    });
    const ctx = {
      ...makeCtx({ providerId: "volcengine-coding" }),
      bus: { request },
    };

    await volcengineVideoAdapter.submit({
      prompt: "coding",
      providerId: "volcengine-coding",
      model: "seedance-coding",
      generateAudio: false,
      watermark: false,
    }, ctx);

    expect(request.mock.calls[0][1].providerId).toBe("volcengine-coding");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://coding.test/v1/contents/generations/tasks");
    expect(opts.headers.Authorization).toBe("Bearer coding-key");
    expect(JSON.parse(opts.body).model).toBe("seedance-coding");
  });

  it("queries the original remote task id and saves the generated video", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: "remote/task:abc" }))
      .mockResolvedValueOnce(jsonResponse({
        status: "succeeded",
        content: { video_url: "https://cdn.test/video.mp4" },
      }))
      .mockResolvedValueOnce(mediaResponse());
    const ctx = makeCtx();

    const submitted = await volcengineVideoAdapter.submit({ prompt: "ocean" }, ctx);
    const queried = await volcengineVideoAdapter.query(submitted.taskId, ctx);

    const queryUrl = mockFetch.mock.calls[1][0];
    expect(queryUrl).toBe("https://ark.test/api/v3/contents/generations/tasks/remote%2Ftask%3Aabc");
    expect(mockFetch.mock.calls[2][0]).toBe("https://cdn.test/video.mp4");
    expect(queried).toEqual({ status: "success", files: ["remote/task:abc-saved.mp4"] });
  });

  it("reports failed remote tasks", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: { status: "failed", error: { message: "quota exceeded" } },
    }));
    const ctx = makeCtx();
    const taskId = "volcvideo_" + Buffer.from("volcengine", "utf8").toString("hex") + "_" + Buffer.from("remote", "utf8").toString("base64url");

    await expect(volcengineVideoAdapter.query(taskId, ctx)).resolves.toEqual({
      status: "failed",
      failReason: "quota exceeded",
    });
  });

  it("advertises 15 second duration support in capabilities", () => {
    expect(volcengineVideoAdapter.capabilities.durations).toContain(15);
  });
});
