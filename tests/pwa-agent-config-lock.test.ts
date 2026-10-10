// @ts-nocheck
import fs from "fs";
import os from "os";
import { Hono } from "hono";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/config-loader.js", () => ({
  clearConfigCache: vi.fn(),
  saveConfig: vi.fn(),
}));

describe("PWA agent config lock", () => {
  let tempRoot;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-pwa-agent-lock-"));
    fs.mkdirSync(path.join(tempRoot, "codia"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "codia", "config.yaml"), "agent:\n  name: Codia\n", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("blocks model-related agent config writes for PWA sessions", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.js");
    const app = new Hono();
    const engine = {
      agentsDir: tempRoot,
      currentAgentId: "codia",
      setLocale: vi.fn(),
      getAgent: vi.fn(() => ({ agentName: "Codia" })),
      invalidateAgentListCache: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: { saveProvider: vi.fn(), removeProvider: vi.fn() },
    };

    const route = new Hono();
    route.use("*", async (c, next) => {
      c.set("pwaSession", { userId: "BoshiPOC" });
      await next();
    });
    route.route("/api", createAgentsRoute(engine));
    app.route("", route);

    const res = await app.request("/api/agents/codia/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: { chat: { id: "gpt-4o", provider: "openai" } } }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "pwa_model_locked" });
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });
});
