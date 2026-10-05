import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/config-loader.js", () => ({
  saveConfig: vi.fn(),
  clearConfigCache: vi.fn(),
}));

vi.mock("../lib/tools/experience.js", () => ({
  listExperienceDocuments: vi.fn(() => []),
  normalizeExperienceCategory: vi.fn((value) => String(value || "").trim()),
  rebuildIndex: vi.fn(),
  syncExperienceCategories: vi.fn(),
}));

describe("agents route tools.disabled", () => {
  let tempRoot;
  let agentDir;
  let app;
  let engine;
  const agentId = "hana";

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-tools-route-"));
    agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      "tools:\n  disabled: []\n",
      "utf-8",
    );

    const { createAgentsRoute } = await import("../server/routes/agents.js");

    const fakeAgent = {
      id: agentId,
      tools: [
        { name: "read" },
        { name: "bash" },
        { name: "browser" },
        { name: "cron" },
        { name: "install_skill" },
        { name: "update_settings" },
      ],
    };

    engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      getAgent: vi.fn(() => fakeAgent),
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      pluginManager: {
        getAllTools: vi.fn(() => [{ name: "beautify_create-cover", _pluginId: "beautify" }]),
      },
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => [{ id: agentId }]),
      getLocale: vi.fn(() => ""),
      getTimezone: vi.fn(() => ""),
      getSandbox: vi.fn(() => false),
      getFileBackup: vi.fn(() => false),
      getUpdateChannel: vi.fn(() => "stable"),
      getThinkingLevel: vi.fn(() => "auto"),
      getLearnSkills: vi.fn(() => true),
      getHeartbeatMaster: vi.fn(() => true),
    };

    app = new Hono();
    app.route("/api", createAgentsRoute(engine));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("accepts a valid subset of optional tools", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: ["browser", "cron"] } }),
    });

    expect(res.status).toBe(200);
  });

  it("returns stable optional tool toggles even before runtime has all optional tools", async () => {
    engine.getAgent.mockReturnValueOnce({ id: agentId, tools: [{ name: "wait" }] });

    const res = await app.request(`/api/agents/${agentId}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.availableTools).toEqual(expect.arrayContaining([
      "wait",
      "automation",
      "beautify",
      "browser",
      "cron",
      "dm",
      "install_skill",
      "update_settings",
      "workflow",
    ]));
  });

  it("accepts an empty tools.disabled list", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: [] } }),
    });

    expect(res.status).toBe(200);
  });

  it("rejects non-optional tool names", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: ["read"] } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("read");
    expect(body.error).toContain("Only optional tools");
  });

  it("lists only invalid names when valid and invalid tools are mixed", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: ["browser", "bash", "edit"] } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("bash");
    expect(body.error).toContain("edit");

    const invalidPortion = body.error.split(".")[0];
    expect(invalidPortion).not.toContain("browser");
  });

  it("rejects non-array tools.disabled", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: { disabled: "browser" } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be an array");
  });

  it("returns availableTools from the keyed agent lookup", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.availableTools)).toBe(true);
    expect(body.availableTools).toContain("read");
    expect(body.availableTools).toContain("browser");
    expect(body.availableTools).toContain("cron");
    expect(engine.getAgent).toHaveBeenCalledWith(agentId);
  });
});
