import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiImageAdapter } from "../adapters/openai.ts";

const IMAGE_RESPONSE = JSON.stringify({
  data: [{ b64_json: Buffer.from("fake-openai-image").toString("base64") }],
});

function mockResponse(ok: boolean, status: number, text: string): Response {
  return {
    ok,
    status,
    text: async () => text,
  } as Response;
}

function createCtx(tmpDir, overrides: { defaultImageModel?: any } = {}) {
  return {
    dataDir: tmpDir,
    config: {
      get: (key) => {
        if (key === "defaultImageModel") return overrides.defaultImageModel || { provider: "openai", id: "gpt-image-1" };
        if (key === "providerDefaults") return {};
        return {};
      },
    },
    bus: {
      request: vi.fn(async () => ({
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
      })),
    },
  };
}

describe("openaiImageAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses multipart form data for image edits", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-image-edit-"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(true, 200, IMAGE_RESPONSE),
    );

    const result = await openaiImageAdapter.submit({
      prompt: "restyle this",
      image: "data:image/png;base64,QUJD",
      ratio: "1:1",
    }, createCtx(tmpDir));

    expect(result.files).toHaveLength(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://api.openai.com/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(fs.existsSync(path.join(tmpDir, "generated", result.files[0]))).toBe(true);
  });

  it("falls back to generations with image_urls when edits are forbidden", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-image-edit-403-"));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse(
        false,
        403,
        JSON.stringify({ error: { message: "permission insufficient for image edits" } }),
      ))
      .mockResolvedValueOnce(mockResponse(true, 200, IMAGE_RESPONSE));

    const result = await openaiImageAdapter.submit({
      prompt: "restyle this",
      image: "data:image/png;base64,QUJD",
      ratio: "1:1",
    }, createCtx(tmpDir));

    expect(result.files).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.openai.com/v1/images/generations");
    const fallbackInit = fetchMock.mock.calls[1][1] as RequestInit;
    const fallbackBody = JSON.parse(String(fallbackInit.body));
    expect(fallbackBody.image_urls).toEqual(["data:image/png;base64,QUJD"]);
    expect(fallbackBody).not.toHaveProperty("image");
    expect(fs.existsSync(path.join(tmpDir, "generated", result.files[0]))).toBe(true);
  });

  it("accepts images param for multi-reference edits", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-image-images-param-"));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse(
        false,
        403,
        JSON.stringify({ error: { message: "permission insufficient for image edits" } }),
      ))
      .mockResolvedValueOnce(mockResponse(true, 200, IMAGE_RESPONSE));

    await openaiImageAdapter.submit({
      prompt: "combine refs",
      images: ["data:image/png;base64,QUJD", "data:image/png;base64,REVG"],
      ratio: "1:1",
    }, createCtx(tmpDir));

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.openai.com/v1/images/generations");
    const fallbackInit = fetchMock.mock.calls[1][1] as RequestInit;
    const fallbackBody = JSON.parse(String(fallbackInit.body));
    expect(fallbackBody.image_urls).toEqual([
      "data:image/png;base64,QUJD",
      "data:image/png;base64,REVG",
    ]);
  });

  it("does not send a chat model when a stale default image model points at GPT-5.5", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-image-stale-chat-default-"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(true, 200, IMAGE_RESPONSE),
    );

    await openaiImageAdapter.submit(
      { prompt: "simple image" },
      createCtx(tmpDir, { defaultImageModel: { provider: "openai", id: "gpt-5.5" } }),
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe("gpt-image-1");
  });
});
