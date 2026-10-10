import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const ASSETS_DIR = path.join(ROOT, "desktop", "dist-renderer", "assets");
const MAX_RENDERER_JS_CHUNK_BYTES = 500 * 1024;
const KNOWN_LAZY_CHUNK_LIMITS = [
  { pattern: /^editor-markdown-support-[\w-]+\.js$/, maxBytes: 650 * 1024 },
  { pattern: /^mermaid-parser-vendor-[\w-]+\.js$/, maxBytes: 650 * 1024 },
  { pattern: /^settings-core-[\w-]+\.js$/, maxBytes: 600 * 1024 },
];

function getChunkBudget(name) {
  const knownLazyChunk = KNOWN_LAZY_CHUNK_LIMITS.find(({ pattern }) => pattern.test(name));
  return knownLazyChunk?.maxBytes ?? MAX_RENDERER_JS_CHUNK_BYTES;
}

describe("renderer chunk budget", () => {
  it("keeps built renderer JavaScript chunks below the Vite warning threshold", () => {
    if (!fs.existsSync(ASSETS_DIR)) {
      console.warn("[renderer-chunk-budget] dist-renderer assets missing; run npm run build:renderer for a strict check.");
      return;
    }

    const oversized = fs.readdirSync(ASSETS_DIR)
      .filter((name) => name.endsWith(".js"))
      .map((name) => {
        const filePath = path.join(ASSETS_DIR, name);
        return { name, size: fs.statSync(filePath).size };
      })
      .filter((item) => item.size > getChunkBudget(item.name))
      .sort((a, b) => b.size - a.size);

    expect(oversized).toEqual([]);
  });
});
