import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPackageSizeTrend, recordPackageSizeTrendHistory } from "../scripts/package-size-trend.mjs";

describe("package size trend", () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeRoot() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-size-trend-"));
    fs.mkdirSync(path.join(tempRoot, "desktop", "dist-renderer", "assets"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "dist-server"), { recursive: true });
    return tempRoot;
  }

  function writeBytes(relPath, size) {
    const filePath = path.join(tempRoot, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(size, 1));
  }

  it("blocks package assets that exceed hard byte limits even without a baseline", () => {
    const root = makeRoot();
    writeBytes(path.join("desktop", "dist-renderer", "assets", "main.js"), 11);
    writeBytes(path.join("dist-server", "server.bin"), 4);
    writeBytes(path.join("desktop", "dist-renderer", "model.wasm"), 5);

    const report = collectPackageSizeTrend({
      root,
      baselineFile: path.join(root, "missing-baseline.json"),
      hardMaxBytes: {
        "renderer-assets": 10,
        "server-bundle": 10,
        "wasm-assets": 10,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "package-size-baseline",
        kind: "missing-baseline",
      }),
      expect.objectContaining({
        id: "renderer-assets",
        kind: "hard-limit",
        sizeBytes: 16,
        hardMaxBytes: 10,
      }),
    ]));
    expect(report.items.find((item) => item.id === "renderer-assets")).toMatchObject({
      hardMaxBytes: 10,
      exceedsHardMax: true,
    });
  });

  it("records bounded package size history for later trend comparisons", () => {
    const root = makeRoot();
    const historyFile = path.join(root, "artifacts", "package-size-trend-history.json");
    const first = collectPackageSizeTrend({ root, baselineFile: path.join(root, "baseline.json") });
    recordPackageSizeTrendHistory(first, { historyFile, maxEntries: 2 });
    recordPackageSizeTrendHistory({ ...first, generatedAt: "2026-06-01T00:00:01.000Z" }, { historyFile, maxEntries: 2 });
    recordPackageSizeTrendHistory({ ...first, generatedAt: "2026-06-01T00:00:02.000Z" }, { historyFile, maxEntries: 2 });

    const history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0].generatedAt).toBe("2026-06-01T00:00:01.000Z");
    expect(history.entries[1].items.map((item) => item.id)).toEqual([
      "surface-package",
      "renderer-assets",
      "server-bundle",
      "wasm-assets",
    ]);
  });

  it("initializes a missing baseline so later runs can detect growth", () => {
    const root = makeRoot();
    const baselineFile = path.join(root, "artifacts", "package-size-trend-baseline.json");
    writeBytes(path.join("desktop", "dist-renderer", "assets", "main.js"), 12);
    writeBytes(path.join("dist-server", "server.bin"), 8);

    const initialized = collectPackageSizeTrend({
      root,
      baselineFile,
      initializeMissingBaseline: true,
    });

    expect(initialized.baseline).toBe("artifacts/package-size-trend-baseline.json");
    expect(initialized.baselineCreated).toBe(true);
    expect(fs.existsSync(baselineFile)).toBe(true);
    expect(initialized.items.find((item) => item.id === "renderer-assets")).toMatchObject({
      baselineBytes: 12,
      deltaBytes: 0,
      deltaRatio: 0,
    });

    writeBytes(path.join("desktop", "dist-renderer", "assets", "extra.js"), 12);
    const grown = collectPackageSizeTrend({
      root,
      baselineFile,
      growthBytes: 1,
      growthRatio: 0.1,
    });

    expect(grown.baseline).toBe("artifacts/package-size-trend-baseline.json");
    expect(grown.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "renderer-assets",
        kind: "trend-growth",
        baselineBytes: 12,
        sizeBytes: 24,
      }),
    ]));
  });
});
