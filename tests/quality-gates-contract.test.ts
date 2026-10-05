import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8"));
}

function readYaml(relativePath) {
  return yaml.load(fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("quality gates", () => {
  it("typecheck covers app TypeScript, root TypeScript tests, and workspace package sources", () => {
    const tsconfig = readJson("tsconfig.json");
    const tsconfigTest = readJson("tsconfig.test.json");
    const packageJson = readJson("package.json");

    expect(tsconfig.include).toEqual(expect.arrayContaining([
      "desktop/src/**/*.ts",
      "desktop/src/**/*.tsx",
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx",
    ]));
    expect(tsconfigTest.include).toEqual(expect.arrayContaining([
      "tests/**/*.ts",
    ]));
    expect(packageJson.scripts.typecheck).toContain("tsconfig.test.json");
  });

  it("lint checks the repository through eslint.config.js instead of a hand-picked directory subset", () => {
    const packageJson = readJson("package.json");

    expect(packageJson.scripts.lint).toBe("eslint .");
  });

  it("package builds use the workspace graph instead of a hard-coded package list", () => {
    const packageJson = readJson("package.json");

    expect(packageJson.scripts["build:packages"]).toBe("npm run build --workspaces --if-present");
  });

  it("CI runs lint before build and tests can merge to main", () => {
    const ci = readYaml(".github/workflows/ci.yml");
    const runSteps = ci.jobs.test.steps
      .map((step) => step.run)
      .filter(Boolean);

    const lintIndex = runSteps.indexOf("npm run lint");
    const buildIndex = runSteps.indexOf("npm run build:renderer");
    const testIndex = runSteps.indexOf("npm test");

    expect(lintIndex).toBeGreaterThan(-1);
    expect(lintIndex).toBeLessThan(buildIndex);
    expect(lintIndex).toBeLessThan(testIndex);
  });

  it("keeps build host, bundled server runtime, and bundle targets aligned on Node 24", () => {
    const packageJson = readJson("package.json");
    const buildServer = readText("scripts/build-server.mjs");
    const serverConfig = readText("vite.config.server.js");
    const mainConfig = readText("vite.config.main.js");
    const preloadConfig = readText("vite.config.preload.js");
    const ci = readYaml(".github/workflows/ci.yml");
    const build = readYaml(".github/workflows/build.yml");

    expect(packageJson.engines.node).toBe(">=24.12.0 <25");
    expect(buildServer).toContain('const NODE_VERSION = "v24.15.0"');
    expect(buildServer).toContain("--target=node24");
    expect(serverConfig).toContain('target: "node24"');
    expect(mainConfig).toContain('target: "node24"');
    expect(preloadConfig).toContain('target: "node24"');
    expect(ci.jobs.test.strategy.matrix["node-version"]).toEqual(["24.15.0"]);
    expect(build.jobs.build.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          with: expect.objectContaining({ "node-version": "24.15.0" }),
        }),
      ]),
    );
  });

  it("verifies downloaded Node runtime archives before extraction", () => {
    const buildServer = readText("scripts/build-server.mjs");

    expect(buildServer).toContain("NODE_RUNTIME_SHA256");
    expect(buildServer).toContain("verifyNodeRuntimeArchive");
    expect(buildServer).toContain("createHash(\"sha256\")");
    expect(buildServer).toContain("node runtime archive checksum mismatch");
  });
});
