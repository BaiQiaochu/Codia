import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentsRoute } from "../server/routes/agents.js";

describe("agent config editor typography route", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("saves editor typography through the global editor preference setter", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-editor-config-"));
    const agentsDir = path.join(tempRoot, "agents");
    const agentDir = path.join(agentsDir, "codia");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");

    let editor = null;
    const engine = {
      agentsDir,
      productDir: path.join(tempRoot, "product"),
      currentAgentId: "codia",
      setEditor: vi.fn((value) => { editor = value; }),
      getEditor: vi.fn(() => editor),
      updateConfig: vi.fn(async () => {}),
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
      },
      onProviderChanged: vi.fn(async () => {}),
      invalidateAgentListCache: vi.fn(),
      getAgent: () => ({ id: "codia" }),
      emitEvent: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/codia/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        editor: {
          markdown: {
            bodyFontSize: 18,
            contentPadding: 30,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(engine.setEditor).toHaveBeenCalledWith({
      markdown: {
        bodyFontSize: 18,
        contentPadding: 30,
      },
    });
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "codia" });
  });

  it("returns a diagnostic error when the runtime cannot save global editor preferences", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-editor-config-"));
    const agentsDir = path.join(tempRoot, "agents");
    const agentDir = path.join(agentsDir, "codia");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Codia\n", "utf-8");

    const app = new Hono();
    app.route("/api", createAgentsRoute({
      agentsDir,
      productDir: path.join(tempRoot, "product"),
      currentAgentId: "codia",
      updateConfig: vi.fn(async () => {}),
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
      },
      onProviderChanged: vi.fn(async () => {}),
      invalidateAgentListCache: vi.fn(),
      getAgent: () => ({ id: "codia" }),
      emitEvent: vi.fn(),
    }));

    const res = await app.request("/api/agents/codia/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor: { markdown: { bodyFontSize: 18 } } }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Global config field "editor" cannot be saved: engine.setEditor is unavailable',
    });
  });
});
