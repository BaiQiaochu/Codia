// @ts-nocheck
import { describe, expect, it } from "vitest";
import { ExecutionRouter } from "../core/execution-router.js";

function createRouter({ models = [], credentials = {} } = {}) {
  return new ExecutionRouter(
    (ref) => {
      if (!ref) return null;
      if (typeof ref === "object") {
        return models.find((model) => model.id === ref.id && model.provider === ref.provider) || null;
      }
      const slash = String(ref).indexOf("/");
      const provider = slash > 0 ? String(ref).slice(0, slash) : "";
      const id = slash > 0 ? String(ref).slice(slash + 1) : String(ref);
      return models.find((model) => model.id === id && model.provider === provider) || null;
    },
    {
      getCredentials: (provider) => credentials[provider] || null,
    },
  );
}

describe("ExecutionRouter trace diagnostics", () => {
  it("explains why a selected route won without exposing secrets", () => {
    const router = createRouter({
      models: [
        { id: "gpt-5.5", provider: "relay", api: "openai-responses", input: ["text", "image"] },
      ],
      credentials: {
        relay: {
          api: "openai-responses",
          apiKey: "sk-secret",
          baseUrl: "https://relay.example.com/v1",
        },
      },
    });

    const trace = router.traceResolve("chat", {
      models: { chat: { id: "gpt-5.5", provider: "relay" } },
    });

    expect(trace.ok).toBe(true);
    expect(trace.selected).toMatchObject({
      role: "chat",
      modelId: "gpt-5.5",
      providerId: "relay",
      api: "openai-responses",
      baseHost: "relay.example.com",
      credentialSource: "provider_registry",
      capability: { required: "chat", matched: true },
    });
    expect(trace.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "chat",
        source: "agent.models.chat",
        ref: "relay/gpt-5.5",
        status: "selected",
        reason: "selected",
      }),
    ]));
    expect(trace.trace).toEqual(expect.arrayContaining([
      "role chat resolved from agent.models.chat",
      "provider relay credentials resolved without exposing secrets",
      "route selected relay/gpt-5.5",
    ]));
    expect(JSON.stringify(trace)).not.toContain("sk-secret");
  });

  it("records utility chat fallback paths for unconfigured utility roles", () => {
    const router = createRouter({
      models: [
        { id: "chat-model", provider: "relay", api: "openai-completions" },
      ],
      credentials: {
        relay: {
          api: "openai-completions",
          apiKey: "sk-secret",
          baseUrl: "https://relay.example.com/v1",
        },
      },
    });

    const trace = router.traceUtilityConfig({
      models: { chat: { id: "chat-model", provider: "relay" } },
    });

    expect(trace.ok).toBe(true);
    expect(trace.selected).toMatchObject({
      utility: { modelId: "chat-model", providerId: "relay", fallbackFrom: "chat" },
      utility_large: { modelId: "chat-model", providerId: "relay", fallbackFrom: "chat" },
    });
    expect(trace.fallbackPath).toEqual([
      "utility -> chat",
      "utility_large -> chat",
    ]);
    expect(trace.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: "utility", status: "rejected", reason: "not_configured" }),
      expect.objectContaining({ slot: "utility_large", status: "rejected", reason: "not_configured" }),
      expect.objectContaining({
        slot: "utility",
        source: "agent.models.chat",
        status: "selected",
        reason: "fallback_to_chat",
      }),
      expect.objectContaining({
        slot: "utility_large",
        source: "agent.models.chat",
        status: "selected",
        reason: "fallback_to_chat",
      }),
    ]));
    expect(JSON.stringify(trace)).not.toContain("sk-secret");
  });

  it("reports unavailable providers as rejected candidates", () => {
    const router = createRouter({
      models: [
        { id: "broken-model", provider: "missing-provider", api: "openai-responses" },
      ],
      credentials: {},
    });

    const trace = router.traceResolve("chat", {
      models: { chat: { id: "broken-model", provider: "missing-provider" } },
    });

    expect(trace.ok).toBe(false);
    expect(trace.selected).toBeNull();
    expect(trace.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "chat",
        ref: "missing-provider/broken-model",
        status: "rejected",
        reason: "provider_missing_credentials",
      }),
    ]));
    expect(trace.trace).toEqual(expect.arrayContaining([
      "route rejected missing-provider/broken-model: provider_missing_credentials",
    ]));
  });
});
