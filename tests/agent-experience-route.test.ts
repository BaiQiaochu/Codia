import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agents route experience toggle", () => {
  let tempRoot;
  let agentDir;
  let app;
  let engine;
  const agentId = "codia";

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-exp-route-"));
    agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(path.join(agentDir, "experience"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");
    fs.writeFileSync(
      path.join(agentDir, "experience", "workflow.md"),
      "<!-- experience-title: d29ya2Zsb3c -->\n1. Keep changes small.\n",
      "utf-8",
    );

    const { createAgentsRoute } = await import("../server/routes/agents.js");
    engine = {
      agentsDir: tempRoot,
      currentAgentId: agentId,
      getAgent: vi.fn(() => ({ id: agentId, tools: [], experienceEnabled: false })),
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
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

  it("injects disabled experience config for legacy configs", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experience).toEqual({ enabled: false });
  });

  it("does not expose stored experience while paused", async () => {
    const res = await app.request(`/api/agents/${agentId}/experience`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "experience is paused" });
  });

  it("rejects experience writes while paused and preserves files", async () => {
    const res = await app.request(`/api/agents/${agentId}/experience`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# workflow\n1. overwritten\n" }),
    });

    expect(res.status).toBe(403);
    const stored = fs.readFileSync(path.join(agentDir, "experience", "workflow.md"), "utf-8");
    expect(stored).toContain("Keep changes small.");
  });
});
