// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createModelsRoute } from "../server/routes/models.js";

describe("models health route provider compat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs health checks through callText with full model metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    const app = new Hono();
    const engine = {
      resolveModelWithCredentials: vi.fn(() => ({
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
        provider: "dashscope",
        model: {
          id: "qwen3.5-plus",
          provider: "dashscope",
          quirks: ["enable_thinking"],
        },
      })),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "qwen3.5-plus", provider: "dashscope" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 200, provider: "dashscope" });
    expect(engine.resolveModelWithCredentials).toHaveBeenCalledWith({
      id: "qwen3.5-plus",
      provider: "dashscope",
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen3.5-plus");
    expect(body.enable_thinking).toBe(false);
  });
});
