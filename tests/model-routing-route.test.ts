import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createModelsRoute } from "../server/routes/models.js";

describe("model routing diagnostics route", () => {
  it("exposes sanitized effective routing for active and shared models", async () => {
    const app = new Hono();
    const engine = {
      currentModel: { id: "gpt-5.5", provider: "relay", name: "GPT 5.5", input: ["text", "image"], reasoning: true },
      activeSessionModel: { id: "qwen3.6-27b", provider: "dashscope", name: "Qwen 3.6 27B", quirks: ["enable_thinking"], reasoning: true },
      availableModels: [],
      getSharedModels: vi.fn(() => ({
        utility: { id: "gpt-5.5", provider: "relay" },
        vision: { id: "deepseek-vl", provider: "deepseek", image: true },
      })),
      resolveModelWithCredentials: vi.fn((ref) => {
        const id = typeof ref === "string" ? ref : ref?.id;
        const provider = typeof ref === "object" ? ref.provider : "relay";
        if (id === "qwen3.6-27b") {
          return {
            provider: "dashscope",
            api: "openai-completions",
            api_key: "sk-secret",
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            model: {
              id,
              provider: "dashscope",
              name: "Qwen 3.6 27B",
              quirks: ["enable_thinking"],
              reasoning: true,
              maxTokens: 131072,
            },
          };
        }
        if (id === "deepseek-vl") {
          return {
            provider: "deepseek",
            api: "openai-responses",
            api_key: "sk-secret",
            base_url: "https://api.deepseek.com/v1",
            model: { id, provider, name: "DeepSeek VL", input: ["text", "image"], image: true },
          };
        }
        return {
          provider: "relay",
          api: "openai-responses",
          api_key: "sk-secret",
          base_url: "https://relay.example.com/v1",
          model: { id, provider: "relay", name: "GPT 5.5", input: ["text", "image"], reasoning: true },
        };
      }),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/routing");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      routes: [
        {
          slot: "active",
          id: "qwen3.6-27b",
          provider: "dashscope",
          api: "openai-completions",
          endpointKind: "chat-completions",
          baseHost: "dashscope.aliyuncs.com",
          thinkingFormat: "qwen",
          imageTransport: "openai-image-url",
          roleNormalization: true,
          trace: [
            "slot active resolved from active session model",
            "credentials resolved without exposing secrets",
            "endpoint kind selected from api openai-completions",
            "input modalities resolved as text/image",
            "thinking format selected from model capabilities",
          ],
        },
        {
          slot: "utility",
          id: "gpt-5.5",
          provider: "relay",
          api: "openai-responses",
          endpointKind: "responses",
          baseHost: "relay.example.com",
          imageTransport: "openai-input-image",
          trace: [
            "slot utility resolved from shared model preferences",
            "credentials resolved without exposing secrets",
            "endpoint kind selected from api openai-responses",
            "input modalities resolved as text/image",
          ],
        },
        {
          slot: "vision",
          id: "deepseek-vl",
          provider: "deepseek",
          endpointKind: "responses",
          imageTransport: "unsupported",
        },
      ],
    });
    expect(JSON.stringify(data)).not.toContain("sk-secret");
    expect(data.routes[2].warnings).toContain("image_transport_unsupported");
  });

  it("reports rejected routing candidates when a configured model misses the requested capability", async () => {
    const app = new Hono();
    const engine = {
      currentModel: null,
      activeSessionModel: null,
      availableModels: [],
      getSharedModels: vi.fn(() => ({
        vision: { id: "text-only", provider: "relay" },
      })),
      resolveModelWithCredentials: vi.fn(() => ({
        provider: "relay",
        api: "openai-responses",
        api_key: "sk-secret",
        base_url: "https://relay.example.com/v1",
        model: { id: "text-only", provider: "relay", name: "Text Only", input: ["text"], image: false },
      })),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/routing");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.routes).toHaveLength(1);
    expect(data.routes[0]).toMatchObject({
      slot: "vision",
      status: "warn",
      id: "text-only",
      provider: "relay",
      warnings: expect.arrayContaining(["missing_capability:image"]),
      candidates: [
        expect.objectContaining({
          slot: "vision",
          ref: "relay/text-only",
          status: "rejected",
          reason: "missing_capability",
          requiredCapability: "image",
        }),
      ],
    });
    expect(JSON.stringify(data)).not.toContain("sk-secret");
  });

  it("includes utility fallback trace entries when the router exposes them", async () => {
    const app = new Hono();
    const engine = {
      currentModel: null,
      activeSessionModel: null,
      availableModels: [],
      getSharedModels: vi.fn(() => ({})),
      resolveModelWithCredentials: vi.fn(),
      traceUtilityConfig: vi.fn(() => ({
        ok: true,
        selected: {
          utility: {
            slot: "utility",
            modelId: "chat-model",
            providerId: "relay",
            api: "openai-completions",
            baseHost: "relay.example.com",
            fallbackFrom: "chat",
          },
          utility_large: {
            slot: "utility_large",
            modelId: "chat-model",
            providerId: "relay",
            api: "openai-completions",
            baseHost: "relay.example.com",
            fallbackFrom: "chat",
          },
        },
        candidates: [
          { slot: "utility", status: "rejected", reason: "not_configured" },
          { slot: "utility", source: "agent.models.chat", ref: "relay/chat-model", status: "selected", reason: "fallback_to_chat" },
          { slot: "utility_large", status: "rejected", reason: "not_configured" },
          { slot: "utility_large", source: "agent.models.chat", ref: "relay/chat-model", status: "selected", reason: "fallback_to_chat" },
        ],
        trace: [
          "utility not configured; falling back to chat",
          "utility selected relay/chat-model",
          "utility_large not configured; falling back to chat",
          "utility_large selected relay/chat-model",
        ],
        fallbackPath: ["utility -> chat", "utility_large -> chat"],
        warnings: [],
      })),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/routing");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slot: "utility",
        id: "chat-model",
        provider: "relay",
        status: "ok",
        trace: expect.arrayContaining(["utility not configured; falling back to chat"]),
        fallbackPath: ["utility -> chat", "utility_large -> chat"],
        candidates: expect.arrayContaining([
          expect.objectContaining({ slot: "utility", status: "rejected", reason: "not_configured" }),
          expect.objectContaining({ slot: "utility", status: "selected", reason: "fallback_to_chat" }),
        ]),
      }),
      expect.objectContaining({
        slot: "utility_large",
        id: "chat-model",
        provider: "relay",
        status: "ok",
      }),
    ]));
    expect(engine.traceUtilityConfig).toHaveBeenCalledTimes(1);
  });
});
