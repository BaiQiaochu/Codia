// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { comfyuiAdapter } from "../plugins/image-gen/adapters/comfyui.js";
import { minimaxMediaAdapter } from "../plugins/image-gen/adapters/minimax-media.js";
import { openaiCompatibleImageAdapter } from "../plugins/image-gen/adapters/openai-compatible.js";
import { openaiImageAdapter } from "../plugins/image-gen/adapters/openai.js";
import { volcengineVideoAdapter } from "../plugins/image-gen/adapters/volcengine-video.js";
import { volcengineImageAdapter } from "../plugins/image-gen/adapters/volcengine.js";

const builtInAdapters = [
  volcengineImageAdapter,
  openaiImageAdapter,
  openaiCompatibleImageAdapter,
  comfyuiAdapter,
  minimaxMediaAdapter,
  volcengineVideoAdapter,
];

function createCtx() {
  return {
    config: { get: () => null },
    bus: {
      request: vi.fn(async (eventName, payload = {}) => {
        if (eventName === "provider:credentials") {
          return {
            api: "openai-completions",
            apiKey: "test-key",
            baseUrl: payload.providerId === "volcengine-coding"
              ? "https://coding.test/api/v3"
              : "https://ark.test/api/v3",
          };
        }
        return {};
      }),
    },
  };
}

function responseOk() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [] }),
  };
}

describe("video adapter auth contract", () => {
  it("only built-in video adapters use link-only auth checks", async () => {
    const videoAdapters = builtInAdapters.filter((adapter) => adapter.types?.includes("video"));

    expect(videoAdapters.map((adapter) => adapter.id)).toEqual(["volcengine-video"]);
    for (const adapter of videoAdapters) {
      expect(adapter.checkAuth).toBeTypeOf("function");
    }
  });

  it("video adapter checkAuth never submits a generation task", async () => {
    const videoAdapters = builtInAdapters.filter((adapter) => adapter.types?.includes("video"));
    const fetchMock = vi.fn().mockResolvedValue(responseOk());
    vi.stubGlobal("fetch", fetchMock);

    try {
      for (const adapter of videoAdapters) {
        const result = await adapter.checkAuth(createCtx());
        expect(result).toEqual({ ok: true });
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (const [url, init = {}] of fetchMock.mock.calls) {
        expect(String(url)).not.toContain("/contents/generations/tasks");
        expect(String(url)).not.toContain("/videos/generations");
        expect(init.method).toBe("GET");
        expect(init.body).toBeUndefined();
      }
      expect(fetchMock.mock.calls[0][0]).toContain("/models");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
