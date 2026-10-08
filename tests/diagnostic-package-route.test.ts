import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { createSystemHealthRoute } from "../server/routes/system-health.ts";

const roots = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-diagnostic-package-"));
  roots.push(root);
  const artifactsDir = path.join(root, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "package-size-trend.json"), JSON.stringify({
    ok: true,
    totals: { renderer: 1200, server: 3400, wasm: 0 },
  }));
  fs.writeFileSync(path.join(artifactsDir, "local-health-check.json"), JSON.stringify({
    ok: false,
    checks: [{ name: "ui", status: 1 }],
  }));
  return { root, artifactsDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("diagnostic package route", () => {
  it("builds a one-click package with UI screenshot, recent errors, package size, and redacted key config", async () => {
    const { root, artifactsDir } = makeFixture();
    const app = new Hono();
    app.route("/api", createSystemHealthRoute({
      config: {
        locale: "zh-CN",
        models: { chat: { id: "deepseek-chat", provider: "deepseek" } },
        api: { provider: "deepseek", api_key: "sk-secret-value" },
      },
      providerRegistry: { getAll: () => new Map(), getAllModelsByType: () => [] },
      pluginManager: { listPlugins: () => [] },
      taskRegistry: { listAll: () => [], listSchedules: () => [] },
      deferredResults: { summary: () => ({}) },
      runtimeDiagnostics: {
        snapshot: () => ({
          records: [{ id: "err-1", severity: "error", title: "Renderer crash" }],
          diagnostics: [{ id: "diag-1", technicalMessage: "boom" }],
        }),
      },
    }, {
      projectRoot: root,
      artifactsDir,
      localHealthPath: path.join(artifactsDir, "local-health-check.json"),
    }));

    const res = await app.request("/api/system/diagnostic-package", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uiScreenshot: { mimeType: "image/png", base64: "PNGDATA" },
        uiSnapshot: { viewport: { width: 1200, height: 800 }, activeTab: "diagnostics" },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ui.screenshot.base64).toBe("PNGDATA");
    expect(data.runtime.recentErrors).toHaveLength(1);
    expect(data.artifacts.packageSizeTrend.totals.server).toBe(3400);
    expect(JSON.stringify(data.keyConfig)).not.toContain("sk-secret-value");
    expect(data.keyConfig.api.api_key).toBe("[REDACTED]");
  });
});
