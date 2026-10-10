import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "ts-migration-inventory.mjs");

function latestUpstreamDir() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^codia-\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

const UPSTREAM_DIR = latestUpstreamDir();
const itWithUpstream = UPSTREAM_DIR ? it : it.skip;

describe("TypeScript migration inventory", () => {
  it("exists as a source-controlled script", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it("excludes generated, VCS, and upstream snapshot paths", () => {
    const text = fs.readFileSync(SCRIPT, "utf8");
    expect(text).toContain("codia-");
    expect(text).toContain("dist-server");
    expect(text).toContain("desktop/dist-renderer");
    expect(text).toContain("node_modules");
    expect(text).toContain(".git");
  });

  itWithUpstream("does not count one-line JS compatibility shims as unmigrated source", () => {
    const output = execFileSync(process.execPath, [SCRIPT, UPSTREAM_DIR], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const inventory = JSON.parse(output);
    const sources = inventory.candidates.map((candidate) => candidate.source);

    expect(sources).not.toContain("shared/errors.ts");
    expect(sources).not.toContain("shared/model-capabilities.ts");
    expect(sources).not.toContain("core/provider-compat/mimo.js");
    expect(sources).not.toContain("lib/providers/openai.js");
  });

  itWithUpstream("has no main-program JavaScript source left when upstream provides TypeScript", () => {
    const output = execFileSync(process.execPath, [SCRIPT, UPSTREAM_DIR], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const inventory = JSON.parse(output);
    const mainSources = inventory.candidates
      .map((candidate) => candidate.source)
      .filter((source) => !source.startsWith("tests/"));

    expect(mainSources).toEqual([]);
  });
});
