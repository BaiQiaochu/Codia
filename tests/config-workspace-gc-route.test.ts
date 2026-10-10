import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigRoute } from "../server/routes/config.js";

function normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

describe("config workspace GC route", () => {
  const tempRoots = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-config-gc-"));
    tempRoots.push(root);
    return root;
  }

  it("persists GC for missing cwd_history and last_cwd entries when reading config", async () => {
    const root = makeRoot();
    const keepWorkspace = path.join(root, "keep");
    const missingWorkspace = path.join(root, "missing");
    fs.mkdirSync(keepWorkspace);
    const engine = {
      config: {
        last_cwd: missingWorkspace,
        cwd_history: [missingWorkspace, keepWorkspace],
      },
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        get: () => null,
      },
      updateConfig: vi.fn(async (patch) => {
        engine.config = { ...engine.config, ...patch };
      }),
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cwd_history).toEqual([normalizedPath(keepWorkspace)]);
    expect(data.last_cwd).toBeNull();
    expect(engine.updateConfig).toHaveBeenCalledWith({
      cwd_history: [normalizedPath(keepWorkspace)],
      last_cwd: null,
    });
  });
});
