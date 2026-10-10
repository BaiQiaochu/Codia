import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createConfigRoute } from "../server/routes/config.ts";

function createApp() {
  const saveProvider = vi.fn();
  const engine = {
    config: {},
    configPath: "E:/tmp/codia-config-test.yaml",
    updateConfig: vi.fn().mockResolvedValue(undefined),
    onProviderChanged: vi.fn().mockResolvedValue(undefined),
    providerRegistry: {
      getAllProvidersRaw: vi.fn(() => ({})),
      saveProvider,
      removeProvider: vi.fn(),
    },
  };
  const app = new Hono();
  app.route("/api", createConfigRoute(engine));
  return { app, engine, saveProvider };
}

describe("provider credential save validation", () => {
  it.each([
    {
      label: "a Chinese API key",
      payload: { providers: { proxy: { api_key: "sk-中文" } } },
      field: "providers.proxy.api_key",
    },
    {
      label: "Chinese text in a provider header",
      payload: { providers: { proxy: { headers: { "X-Provider": "供应商甲" } } } },
      field: "providers.proxy.headers.X-Provider",
    },
    {
      label: "a newline in a provider header",
      payload: { providers: { proxy: { headers: { Authorization: "Bearer ok\r\nX-Evil: injected" } } } },
      field: "providers.proxy.headers.Authorization",
    },
    {
      label: "a control character in an inline API key",
      payload: { api: { provider: "proxy", api_key: "sk-value\u0001" } },
      field: "api.api_key",
    },
  ])("returns an explicit 400 for $label", async ({ payload, field }) => {
    const { app, engine, saveProvider } = createApp();

    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: `${field} must contain printable ASCII characters only`,
      code: "invalid_provider_credential_value",
      field,
    });
    expect(saveProvider).not.toHaveBeenCalled();
    expect(engine.onProviderChanged).not.toHaveBeenCalled();
  });
});
