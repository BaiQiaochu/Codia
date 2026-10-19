// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigRoute } from "../server/routes/config.js";

function makeAgent(tmpDir, overrides = {}) {
  const agentDir = path.join(tmpDir, "agents", "codia");
  const memoryDir = path.join(agentDir, "memory");
  const summariesDir = path.join(memoryDir, "summaries");
  fs.mkdirSync(summariesDir, { recursive: true });

  return {
    id: "codia",
    agentDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    summariesDir,
    summaryManager: { clearCache: vi.fn() },
    factStore: {
      exportAll: vi.fn(() => []),
      clearAll: vi.fn(),
    },
    ...overrides,
  };
}

function makeEngine(agent, tmpDir) {
  return {
    config: {},
    configPath: path.join(tmpDir, "config.yaml"),
    currentAgentId: agent.id,
    agentsDir: path.join(tmpDir, "agents"),
    preferences: {
      getExperimentValue: vi.fn(() => undefined),
    },
    getAgent: vi.fn((id) => (id === agent.id ? agent : null)),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function mountConfigRoute(engine) {
  const app = new Hono();
  app.route("/api", createConfigRoute(engine));
  return app;
}

describe("memory health route", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-memory-routes-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("reports memory health for an explicit agent", async () => {
    const health = {
      rollingSummary: { lastSuccessAt: "2026-06-01T10:00:00.000Z", lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileToday: { lastSuccessAt: "2026-06-01T10:05:00.000Z", lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileFacts: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      deepMemory: { lastSuccessAt: null, lastErrorAt: "2026-06-01T10:10:00.000Z", lastErrorMsg: "LLM timeout", failCount: 2 },
    };
    const memoryTicker = { getHealthStatus: vi.fn(() => health) };
    const agent = makeAgent(tmpDir, { memoryTicker });
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/health?agentId=codia");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(memoryTicker.getHealthStatus).toHaveBeenCalledOnce();
    expect(data).toMatchObject({
      agentId: "codia",
      status: "degraded",
      reason: null,
      failedSteps: ["deepMemory"],
      maxFailCount: 2,
      lastSuccessAt: "2026-06-01T10:05:00.000Z",
      lastErrorAt: "2026-06-01T10:10:00.000Z",
      steps: {
        deepMemory: health.deepMemory,
      },
    });
  });

  it("requires an explicit agentId for memory health", async () => {
    const agent = makeAgent(tmpDir, {
      memoryTicker: { getHealthStatus: vi.fn(() => ({})) },
    });
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/health");
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(agent.memoryTicker.getHealthStatus).not.toHaveBeenCalled();
  });

  it("returns compiled memory sections with editable facts when the experiment is enabled", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "legacy facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "editable-facts.md"), "editable facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    engine.preferences.getExperimentValue = vi.fn((id) => (
      id === "memory.editable_facts" ? true : undefined
    ));
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled?agentId=codia");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.editableFactsEnabled).toBe(true);
    expect(data.sections).toMatchObject({
      facts: "editable facts",
      today: "today part",
      week: "week part",
      longterm: "longterm part",
    });
    expect(data.content).toContain("editable facts");
    expect(data.content).toContain("today part");
  });

  it("rejects retired bulk editing even when the legacy experiment is enabled", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "legacy facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    engine.preferences.getExperimentValue = vi.fn((id) => (
      id === "memory.editable_facts" ? true : undefined
    ));
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/facts?agentId=codia", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: "edited facts" }),
    });
    const data = await res.json();

    expect(res.status).toBe(410);
    expect(data.code).toBe("sourced_memory_required");
    expect(fs.existsSync(path.join(memoryDir, "editable-facts.md"))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8")).toBe("legacy facts");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });
});
