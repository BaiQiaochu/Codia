import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
function availableUpstreamTestRoots() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^openhanako-\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => path.join(ROOT, entry.name, "tests"))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
const UPSTREAM_TESTS_ROOT = availableUpstreamTestRoots()[0];
const itWithUpstreamTests = UPSTREAM_TESTS_ROOT ? it : it.skip;

const GENERATED_OR_TOOLING_SHARED_JS = new Set([
  "shared/dark-watermark.cjs",
  "shared/gsap-runtime-paths.cjs",
]);

const USER_VISIBLE_BRAND_FILES = [
  "package.json",
  "build/installer.nsh",
  "desktop/main.cjs",
  "desktop/server-runtime.cjs",
  "desktop/src/modules/connection-csp.ts",
  "desktop/src/react/services/server-connection.ts",
  "desktop/native/GsapWindowsSandboxHelper/main.cpp",
];

const EXPECTED_DEBRANDED_TEST_ALIASES = new Map<string, string | string[]>([
  ["engine-lifecycle.test.ts", [
    "engine-computer-use-lazy.test.ts",
    "engine-extension-factories.test.ts",
    "engine-session-api.test.ts",
  ]],
  ["hana-runtime-paths.test.ts", "gsap-runtime-paths.test.ts"],
  ["memory-compile-contracts.test.ts", [
    "memory-compile-empty-fingerprint.test.ts",
    "memory-compiled-reset.test.ts",
  ]],
  ["memory-ticker-orchestration.test.ts", [
    "memory-ticker-daily.test.ts",
    "memory-ticker-health.test.ts",
  ]],
  ["office-documents-env-check.test.js", "office-documents-env-check.test.ts"],
  ["python-skill-env-check.test.js", "python-skill-env-check.test.ts"],
  ["server-connection.test.ts", "desktop/src/react/__tests__/services/server-connection.test.ts"],
  ["server-utils.test.ts", [
    "resolve-agent.test.ts",
    "http-route-errors.test.ts",
  ]],
]);

const TEST_LEGACY_COMPATIBILITY_FIXTURE_FILES = new Set([
  "character-card-import.test.ts",
  "first-run-gsap.test.ts",
  "migrations.test.ts",
  "ts-migration-inventory.test.ts",
  "win32-legacy-maintenance.test.ts",
  "win32-legacy-migration.test.ts",
  "win32-sandbox-helper.test.ts",
]);

function toPosix(relativePath) {
  return relativePath.replace(/\\/g, "/");
}

function listFiles(dir, predicate, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(fullPath, predicate, result);
    } else if (entry.isFile() && predicate(fullPath)) {
      result.push(fullPath);
    }
  }
  return result;
}

function debrandedTestPath(relativePath) {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/\.test\.js$/, ".test.ts")
    .replace(/openhanako/gi, "gsap")
    .replace(/hana-runtime/gi, "gsap-runtime");
}

function listAliasTargets(upstreamPath) {
  const direct = EXPECTED_DEBRANDED_TEST_ALIASES.get(upstreamPath)
    || EXPECTED_DEBRANDED_TEST_ALIASES.get(debrandedTestPath(upstreamPath));
  if (!direct) return [];
  return Array.isArray(direct) ? direct : [direct];
}

function isMigratedOrAliased(upstreamPath, migrated) {
  const debrandedPath = debrandedTestPath(upstreamPath);
  if (migrated.has(debrandedPath)) return true;
  const aliases = listAliasTargets(upstreamPath);
  return aliases.length > 0 && aliases.every((target) => migrated.has(target));
}

function currentTestPaths() {
  const rootTests = listFiles(path.join(ROOT, "tests"), (fullPath) => /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(fullPath))
    .map((fullPath) => toPosix(path.relative(path.join(ROOT, "tests"), fullPath)));
  const desktopTestsRoot = path.join(ROOT, "desktop", "src", "react", "__tests__");
  const desktopTests = fs.existsSync(desktopTestsRoot)
    ? listFiles(desktopTestsRoot, (fullPath) => /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(fullPath))
      .map((fullPath) => toPosix(path.relative(ROOT, fullPath)))
    : [];

  return new Set([...rootTests, ...desktopTests]);
}

function duplicateSharedJsSources() {
  const sharedDir = path.join(ROOT, "shared");
  return listFiles(sharedDir, (fullPath) => fullPath.endsWith(".js"))
    .map((fullPath) => toPosix(path.relative(ROOT, fullPath)))
    .filter((relativePath) => !GENERATED_OR_TOOLING_SHARED_JS.has(relativePath))
    .filter((relativePath) => {
      const tsPath = path.join(ROOT, relativePath.replace(/\.js$/, ".ts"));
      return fs.existsSync(tsPath);
    })
    .sort();
}

function desktopReactTestJsSources() {
  const reactDir = path.join(ROOT, "desktop", "src", "react");
  return listFiles(reactDir, (fullPath) => /\.(test|spec)\.js$/.test(fullPath))
    .map((fullPath) => toPosix(path.relative(ROOT, fullPath)))
    .sort();
}

function sharedJsImportSpecifiers() {
  const scanRoots = ["core", "lib", "server", "hub", "desktop/src", "tests", "plugins"];
  const importPattern = /^\s*(?:import\s+(?:[^"'\n]*?\s+from\s*)?["']([^"']*shared\/[^"']+\.js)["']|import\s*\(\s*["']([^"']*shared\/[^"']+\.js)["']|export\s+[^"'\n]*?\s+from\s*["']([^"']*shared\/[^"']+\.js)["'])/gm;
  const offenders = [];

  for (const relativeRoot of scanRoots) {
    const absoluteRoot = path.join(ROOT, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    const files = listFiles(absoluteRoot, (fullPath) => /\.(ts|tsx|mts|cts)$/.test(fullPath));
    for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
        offenders.push(`${toPosix(path.relative(ROOT, file))}: ${match[1] || match[2] || match[3]}`);
      }
    }
  }

  return offenders.sort();
}

function sourceContractJsFileReads() {
  const testRoots = ["tests", "desktop/src/react/__tests__"];
  const runtimeSourceReadPattern =
    /read\(\s*["']((?:core|lib|server|hub|shared)\/[^"']+\.js)["']\s*\)/g;
  const offenders = [];

  for (const relativeRoot of testRoots) {
    const absoluteRoot = path.join(ROOT, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    const files = listFiles(absoluteRoot, (fullPath) => /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(fullPath));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(runtimeSourceReadPattern)) {
        offenders.push(`${toPosix(path.relative(ROOT, file))}: ${match[1]}`);
      }
    }
  }

  return offenders.sort();
}

const BRAND_NEGATIVE_ASSERTION_CONTEXT =
  /debrand|not\.to|not\.toContain|not\.toMatch|legacyBrandPattern|Project Hana|OH-Plugins|Hana Provider Registry|<hana-background-result>/i;

const LOCAL_UPSTREAM_REFERENCE_CONTEXT =
  /UPSTREAM_TESTS_ROOT|openhanako-\d+\.\d+\.\d+|hana-runtime/i;

// These names are still accepted only as compatibility-facing runtime API fields
// in mocks and fixtures. Test values should keep using G-SAP paths/names.
const LEGACY_RUNTIME_API_FIELD_CONTEXT =
  /\b(?:hanakoHome|getHanakoHome|HANA_HOME)\b/i;

const LEGACY_INSTALL_OR_SANDBOX_CONTEXT =
  /legacy|compat|com\.hanako\.sandbox/i;

function isAllowedTestBrandLine(relativePath, context) {
  if (relativePath === "debrand-ts-boundary.test.ts") return true;
  // Copyright attribution is retained even when the product name changes.
  if (relativePath === "readme-polish-contract.test.ts" && context.includes('保留 OpenHanako 上游版权')) return true;
  if (TEST_LEGACY_COMPATIBILITY_FIXTURE_FILES.has(relativePath)) return true;
  return [
    BRAND_NEGATIVE_ASSERTION_CONTEXT,
    LOCAL_UPSTREAM_REFERENCE_CONTEXT,
    LEGACY_RUNTIME_API_FIELD_CONTEXT,
    LEGACY_INSTALL_OR_SANDBOX_CONTEXT,
  ].some((pattern) => pattern.test(context));
}

describe("debranding and TypeScript source boundary", () => {
  itWithUpstreamTests("covers the local upstream tests folder with debranded TypeScript test files", () => {
    const migrated = currentTestPaths();
    const missing = listFiles(UPSTREAM_TESTS_ROOT, (fullPath) => /\.(test|spec)\.(js|ts|tsx|mts|cts)$/.test(fullPath))
      .map((fullPath) => toPosix(path.relative(UPSTREAM_TESTS_ROOT, fullPath)))
      .filter((relativePath) => !isMigratedOrAliased(relativePath, migrated))
      .map(debrandedTestPath)
      .sort();

    expect(missing).toEqual([]);
  });

  it("keeps the tests folder migrated to TypeScript source", () => {
    const testJsFiles = listFiles(path.join(ROOT, "tests"), (fullPath) => fullPath.endsWith(".js"))
      .map((fullPath) => toPosix(path.relative(ROOT, fullPath)))
      .sort();

    expect(testJsFiles).toEqual([]);
  });

  it("keeps desktop React test contracts migrated to TypeScript source", () => {
    expect(desktopReactTestJsSources()).toEqual([]);
  });

  it("maps upstream renamed tests to G-SAP TypeScript equivalents", () => {
    const migrated = currentTestPaths();

    for (const [upstreamPath, currentPathOrPaths] of EXPECTED_DEBRANDED_TEST_ALIASES) {
      const currentPaths = Array.isArray(currentPathOrPaths) ? currentPathOrPaths : [currentPathOrPaths];
      for (const currentPath of currentPaths) {
        expect(migrated.has(currentPath)).toBe(true);
      }
      expect(migrated.has(upstreamPath)).toBe(false);
      expect(fs.existsSync(path.join(ROOT, "tests", upstreamPath))).toBe(false);
    }
  });

  it("keeps non-legacy test fixtures debranded after local upstream migration", () => {
    const forbiddenBrand = /OpenHanako|openhanako|HanaAgent|OH-Works|liliMozi|com\.hanako|\bHanako\b|\bHana\b|hanako|HANAKO/;
    const offendingLines = [];
    const testRoot = path.join(ROOT, "tests");
    const files = listFiles(testRoot, (fullPath) => /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(fullPath));

    for (const file of files) {
      const relativePath = toPosix(path.relative(testRoot, file));
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!forbiddenBrand.test(line)) return;
        const context = [
          lines[index - 1] || "",
          line,
          lines[index + 1] || "",
        ].join("\n");
        if (!isAllowedTestBrandLine(relativePath, context)) {
          offendingLines.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offendingLines).toEqual([]);
  });

  it("does not keep duplicate shared JavaScript source beside TypeScript source", () => {
    expect(duplicateSharedJsSources()).toEqual([]);
  });

  it("does not import deleted shared JavaScript sources from TypeScript files", () => {
    expect(sharedJsImportSpecifiers()).toEqual([]);
  });

  it("does not read deleted JavaScript source paths from source contract tests", () => {
    expect(sourceContractJsFileReads()).toEqual([]);
  });

  it("does not package deleted shared JavaScript source files", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const duplicateSet = new Set(duplicateSharedJsSources());
    const packagedDuplicates = (pkg.build?.files || [])
      .filter((entry) => duplicateSet.has(entry));

    expect(packagedDuplicates).toEqual([]);
  });

  it("keeps package-visible branding on G-SAP and marks retained legacy compatibility", () => {
    const offendingLines = [];
    const forbiddenBrand = /OpenHanako|HanaAgent|OH-Works|liliMozi|com\.hanako/i;

    for (const relativePath of USER_VISIBLE_BRAND_FILES) {
      const absolutePath = path.join(ROOT, relativePath);
      if (!fs.existsSync(absolutePath)) continue;
      const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        const context = [
          lines[index - 1] || "",
          line,
          lines[index + 1] || "",
        ].join("\n");
        if (forbiddenBrand.test(line) && !/legacy|compat/i.test(context)) {
          offendingLines.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offendingLines).toEqual([]);
  });
});
