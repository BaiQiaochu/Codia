// @ts-nocheck
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createAuthRoute } from "../server/routes/auth.js";

function makeEngine(loginImpl: any) {
  return {
    providerRegistry: {
      getAuthJsonKey: vi.fn((provider: string) => provider === "openai-codex-oauth" ? "openai-codex" : provider),
    },
    modelRuntime: {
      getProvider: vi.fn(() => ({ auth: { oauth: {} } })),
      login: vi.fn(loginImpl),
      getProviders: vi.fn(() => [{ id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } }]),
      getProviderAuthStatus: vi.fn(() => ({ configured: false })),
      isUsingOAuth: vi.fn(() => false),
      logout: vi.fn(),
    },
    onProviderChanged: vi.fn(async () => {}),
    availableModels: [],
    preferences: {
      getOAuthCustomModels: vi.fn(() => ({})),
      setOAuthCustomModels: vi.fn(),
    },
  };
}

describe("auth oauth route", () => {
  it("reuses an in-flight callback-server flow for the same provider", async () => {
    let capturedCallbacks: any;
    const engine = makeEngine((_authKey: string, _type: string, interaction: any) => {
      capturedCallbacks = interaction;
      interaction.notify({ type: "auth_url", url: "https://auth.example/start" });
      return new Promise(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const first = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    const second = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    expect(await second.json()).toEqual(await first.clone().json());
    expect(engine.modelRuntime.login).toHaveBeenCalledTimes(1);
    expect(engine.modelRuntime.login).toHaveBeenCalledWith("openai-codex", "oauth", expect.any(Object));
    expect(capturedCallbacks.prompt({ type: "manual_code" })).toBeInstanceOf(Promise);
  });

  it("waits for the same provider flow when the auth URL is still starting", async () => {
    let capturedCallbacks: any;
    let resolveLoginStarted: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      resolveLoginStarted = resolve;
    });
    const engine = makeEngine((_authKey: string, _type: string, interaction: any) => {
      capturedCallbacks = interaction;
      resolveLoginStarted();
      return new Promise(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const firstPromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    await loginStarted;

    const secondPromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    capturedCallbacks.notify({ type: "auth_url", url: "https://auth.example/start" });

    const first = await firstPromise;
    const second = await secondPromise;

    expect(await second.json()).toEqual(await first.json());
    expect(engine.modelRuntime.login).toHaveBeenCalledTimes(1);
  });
});
