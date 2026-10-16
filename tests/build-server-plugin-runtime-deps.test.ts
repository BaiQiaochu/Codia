// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginManager } from "../core/plugin-manager.js";
import { EventBus } from "../hub/event-bus.js";

import {
  collectBundledPluginPackageDependencies,
  collectBundledPluginRuntimeDependencies,
  copyOrTranspileRuntimeDependency,
  copyBundledPluginRuntimeDependencies,
  createTraceFileSystem,
  createTraceIgnore,
  createTraceReadlink,
  rewriteTypeScriptImportSpecifiers,
  transpilePackagedRuntimeTypeScript,
  transpileBundledPluginTypeScript,
  validatePackagedRuntimeImports,
} from "../scripts/build-server-plugin-runtime-deps.mjs";

const PROJECT_ROOT = path.resolve(__dirname, "..");

describe("bundled plugin runtime dependencies", () => {
  let tempDir;
  let rootDir;
  let outDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-runtime-deps-"));
    rootDir = path.join(tempDir, "root");
    outDir = path.join(tempDir, "dist-server", "win-x64");

    fs.mkdirSync(path.join(rootDir, "plugins", "mcp", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "mcp", "index.js"),
      'import { loadRuntime } from "./lib/mcp-runtime.js";\nexport default loadRuntime;\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "plugins", "mcp", "lib", "mcp-runtime.js"),
      'import { createSettingsUpdate } from "../../../lib/tools/settings-update-result.js";\nexport function loadRuntime() { return createSettingsUpdate; }\n',
      "utf-8",
    );

    fs.mkdirSync(path.join(rootDir, "plugins", "image-gen", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "image-gen", "lib", "local-cli-wrapper.js"),
      'import { buildCliArgs } from "../../../core/media-runtime-contract.js";\nexport { buildCliArgs };\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "plugins", "image-gen", "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "image-gen", "tests", "fixture.test.js"),
      'import "../../../server/test-only.js";\n',
      "utf-8",
    );

    fs.mkdirSync(path.join(rootDir, "lib", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "lib", "tools", "settings-update-result.js"),
      "export function createSettingsUpdate() { return {}; }\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "core", "media-runtime-contract.js"),
      "export function buildCliArgs() { return []; }\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies host modules imported by bundled plugin source into the packaged server root", async () => {
    const deps = await collectBundledPluginRuntimeDependencies({ rootDir });

    expect(deps).toEqual([
      path.join("core", "media-runtime-contract.js"),
      path.join("lib", "tools", "settings-update-result.js"),
    ]);

    const copied = await copyBundledPluginRuntimeDependencies({ rootDir, outDir });

    expect(copied).toEqual(deps);
    expect(fs.readFileSync(path.join(outDir, "lib", "tools", "settings-update-result.js"), "utf-8"))
      .toContain("createSettingsUpdate");
    expect(fs.readFileSync(path.join(outDir, "core", "media-runtime-contract.js"), "utf-8"))
      .toContain("buildCliArgs");
    expect(fs.existsSync(path.join(outDir, "plugins", "mcp", "index.js"))).toBe(false);
  });

  it("traces host modules imported by TypeScript plugin source", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "ts-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "ts-plugin", "index.ts"),
      'import { buildCliArgs } from "../../core/media-runtime-contract.js";\nexport default class TsPlugin { onload() { return buildCliArgs; } }\n',
      "utf-8",
    );

    await expect(collectBundledPluginRuntimeDependencies({ rootDir }))
      .resolves.toContain(path.join("core", "media-runtime-contract.js"));
  });

  it("resolves plugin .js imports to TypeScript-only host runtime modules", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "ts-host"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "ts-host", "index.ts"),
      'import { t } from "../../lib/i18n.js";\nexport const label = t("ok");\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "lib", "i18n.ts"),
      'export function t(key: string): string { return `label:${key}`; }\n',
      "utf-8",
    );

    await expect(collectBundledPluginRuntimeDependencies({ rootDir }))
      .resolves.toContain(path.join("lib", "i18n.js"));

    await copyBundledPluginRuntimeDependencies({ rootDir, outDir });

    const outputPath = path.join(outDir, "lib", "i18n.js");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(path.join(outDir, "lib", "i18n.ts"))).toBe(false);
    expect(fs.readFileSync(outputPath, "utf-8")).toContain("function t");
  });

  it("recursively copies host runtime modules imported by traced TypeScript helpers", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "image-gen", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "image-gen", "tools", "generate-image.ts"),
      'import { t } from "../../../lib/i18n.ts";\nexport const name = "generate-image";\nexport const description = t("ok");\nexport async function execute() { return description; }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "lib", "i18n.ts"),
      'import { fromRoot } from "../shared/app-root.ts";\nimport { createModuleLogger } from "./debug-log.ts";\nconst log = createModuleLogger("i18n");\nexport function t(key: string): string { log.log(fromRoot("desktop")); return key; }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "lib", "debug-log.ts"),
      'import { redactLogText } from "./log-redactor.ts";\nexport function createModuleLogger(module: string) { return { log(value: string) { return redactLogText(`${module}:${value}`); } }; }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "lib", "log-redactor.ts"),
      'import redactor from "../shared/log-redactor.cjs";\nexport const { redactLogText } = redactor;\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "shared", "app-root.ts"),
      'export function fromRoot(...segments: string[]) { return segments.join("/"); }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "shared", "log-redactor.cjs"),
      'module.exports = { redactLogText(value) { return String(value); } };\n',
      "utf-8",
    );

    const deps = await collectBundledPluginRuntimeDependencies({ rootDir });

    expect(deps).toEqual(expect.arrayContaining([
      path.join("lib", "i18n.js"),
      path.join("lib", "debug-log.js"),
      path.join("lib", "log-redactor.js"),
      path.join("shared", "app-root.js"),
      path.join("shared", "log-redactor.cjs"),
    ]));
    expect(deps).not.toContain(path.join("shared", "app-root.ts"));

    await copyBundledPluginRuntimeDependencies({ rootDir, outDir });

    for (const runtimeFile of [
      path.join("lib", "i18n.js"),
      path.join("lib", "debug-log.js"),
      path.join("lib", "log-redactor.js"),
      path.join("shared", "app-root.js"),
      path.join("shared", "log-redactor.cjs"),
    ]) {
      expect(fs.existsSync(path.join(outDir, runtimeFile))).toBe(true);
    }
    expect(fs.readFileSync(path.join(outDir, "lib", "i18n.js"), "utf-8"))
      .toContain('from "../shared/app-root.js"');
    expect(fs.readFileSync(path.join(outDir, "lib", "debug-log.js"), "utf-8"))
      .toContain('from "./log-redactor.js"');
  });

  it("validates packaged relative runtime imports after plugins and host helpers are copied", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "image-gen", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "image-gen", "index.js"),
      'import { t } from "../../lib/i18n.js";\nexport default class ImageGen { onload() { return t("ok"); } }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "lib", "i18n.ts"),
      'import { fromRoot } from "../shared/app-root.ts";\nimport { createModuleLogger } from "./debug-log.ts";\nconst log = createModuleLogger("i18n");\nexport function t(key: string): string { log.log(fromRoot("desktop")); return key; }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "lib", "debug-log.ts"),
      'import { redactLogText } from "./log-redactor.ts";\nexport function createModuleLogger(module: string) { return { log(value: string) { return redactLogText(`${module}:${value}`); } }; }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "lib", "log-redactor.ts"),
      'import redactor from "../shared/log-redactor.cjs";\nexport const { redactLogText } = redactor;\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "shared", "app-root.ts"),
      'export function fromRoot(...segments: string[]) { return segments.join("/"); }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "shared", "log-redactor.cjs"),
      'module.exports = { redactLogText(value) { return String(value); } };\n',
      "utf-8",
    );

    fs.cpSync(path.join(rootDir, "plugins"), path.join(outDir, "plugins"), { recursive: true });
    transpileBundledPluginTypeScript({ pluginsDir: path.join(outDir, "plugins") });
    await copyBundledPluginRuntimeDependencies({ rootDir, outDir });

    expect(fs.existsSync(path.join(outDir, "plugins", "image-gen", "tests"))).toBe(false);
    expect(validatePackagedRuntimeImports({ outDir })).toMatchObject({
      missing: [],
    });
  });

  it("fails packaged runtime validation when a relative host import points to a missing JS output", () => {
    fs.mkdirSync(path.join(outDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "lib", "i18n.js"),
      'import { fromRoot } from "../shared/app-root.js";\nexport function t() { return fromRoot("x"); }\n',
      "utf-8",
    );

    expect(() => validatePackagedRuntimeImports({ outDir }))
      .toThrow(/lib[/\\]i18n\.js imports \.\.\/shared\/app-root\.js/);
  });

  it("transpiles TypeScript runtime files copied into the packaged server root", () => {
    fs.mkdirSync(path.join(outDir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(outDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "lib", "i18n.js"),
      'import { fromRoot } from "../shared/app-root.js";\nimport { createModuleLogger } from "./debug-log.js";\nexport const label = createModuleLogger("i18n").log(fromRoot("desktop"));\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(outDir, "lib", "debug-log.ts"),
      "export function createModuleLogger(name: string) { return { log(value: string) { return `${name}:${value}`; } }; }\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(outDir, "shared", "app-root.ts"),
      "export function fromRoot(...segments: string[]) { return segments.join('/'); }\n",
      "utf-8",
    );

    expect(() => validatePackagedRuntimeImports({ outDir }))
      .toThrow(/shared[/\\]app-root\.js/);

    const outputs = transpilePackagedRuntimeTypeScript({ outDir, roots: ["lib", "shared"] });

    expect(outputs).toEqual(expect.arrayContaining([
      path.join("lib", "debug-log.js"),
      path.join("shared", "app-root.js"),
    ]));
    expect(fs.existsSync(path.join(outDir, "lib", "debug-log.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "shared", "app-root.js"))).toBe(true);
    expect(validatePackagedRuntimeImports({ outDir })).toMatchObject({ missing: [] });
  });

  it("transpiles required TypeScript runtime helpers to JavaScript outputs", () => {
    fs.mkdirSync(path.join(rootDir, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "server", "hono-helpers.ts"),
      "export function strictJson(value: unknown): unknown { return value; }\n",
      "utf-8",
    );

    expect(copyOrTranspileRuntimeDependency({
      rootDir,
      outDir,
      relativePath: path.join("server", "hono-helpers.js"),
    })).toBe(path.join("server", "hono-helpers.js"));

    const outputPath = path.join(outDir, "server", "hono-helpers.js");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, "utf-8")).toContain("strictJson");
  });

  it("transpiles traced TypeScript runtime helper paths to JavaScript outputs", () => {
    fs.mkdirSync(path.join(rootDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "lib", "i18n.ts"),
      "export function t(key: string): string { return key; }\n",
      "utf-8",
    );

    expect(copyOrTranspileRuntimeDependency({
      rootDir,
      outDir,
      relativePath: path.join("lib", "i18n.ts"),
    })).toBe(path.join("lib", "i18n.js"));

    const outputPath = path.join(outDir, "lib", "i18n.js");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(path.join(outDir, "lib", "i18n.ts"))).toBe(false);
    expect(fs.readFileSync(outputPath, "utf-8")).toContain("function t");
  });

  it("rewrites relative TypeScript import specifiers for the packaged Node runtime", () => {
    const output = rewriteTypeScriptImportSpecifiers([
      'import "./side-effect.ts";',
      'import { a } from "./a.ts";',
      'export { b } from "../b.mts";',
      'const c = await import("./c.cts");',
      'const d = require("./d.ts");',
      'import "external-package/file.ts";',
    ].join("\n"));

    expect(output).toContain('import "./side-effect.js";');
    expect(output).toContain('from "./a.js";');
    expect(output).toContain('from "../b.mjs";');
    expect(output).toContain('import("./c.cjs")');
    expect(output).toContain('require("./d.js")');
    expect(output).toContain('import "external-package/file.ts";');
  });

  it("transpiles copied TypeScript plugin files to JavaScript for the Node 22 runtime", () => {
    const pluginsDir = path.join(outDir, "plugins");
    fs.mkdirSync(path.join(pluginsDir, "ts-plugin", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "ts-plugin", "index.ts"),
      'import "./tools/run.ts";\nexport default class TsPlugin { value: number = 1; }\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginsDir, "ts-plugin", "tools", "run.ts"),
      "export const name: string = 'run'; export function execute() { return name; }\n",
      "utf-8",
    );

    const outputs = transpileBundledPluginTypeScript({ pluginsDir });

    expect(outputs).toEqual([
      path.join("ts-plugin", "index.js"),
      path.join("ts-plugin", "tools", "run.js"),
    ]);
    expect(fs.existsSync(path.join(pluginsDir, "ts-plugin", "index.ts"))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, "ts-plugin", "index.js"))).toBe(true);
    expect(fs.readFileSync(path.join(pluginsDir, "ts-plugin", "index.js"), "utf-8"))
      .toContain('import "./tools/run.js";');
    expect(fs.readFileSync(path.join(pluginsDir, "ts-plugin", "tools", "run.js"), "utf-8"))
      .toContain("export");
  });

  it("packages the built-in image-gen plugin as ESM-loadable runtime JavaScript", async () => {
    const packagedPluginsDir = path.join(outDir, "plugins");
    fs.mkdirSync(path.join(outDir, "desktop", "src"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    fs.cpSync(path.join(PROJECT_ROOT, "desktop", "src", "locales"), path.join(outDir, "desktop", "src", "locales"), { recursive: true });
    fs.cpSync(path.join(PROJECT_ROOT, "shared"), path.join(outDir, "shared"), { recursive: true });
    fs.cpSync(path.join(PROJECT_ROOT, "plugins", "image-gen"), path.join(packagedPluginsDir, "image-gen"), { recursive: true });

    transpileBundledPluginTypeScript({ pluginsDir: packagedPluginsDir });
    for (const relativePath of [
      path.join("lib", "i18n.js"),
      path.join("lib", "debug-log.js"),
      path.join("lib", "log-redactor.js"),
      path.join("shared", "app-root.js"),
      path.join("shared", "log-redactor.cjs"),
      path.join("server", "hono-helpers.js"),
    ]) {
      copyOrTranspileRuntimeDependency({ rootDir: PROJECT_ROOT, outDir, relativePath });
    }
    await copyBundledPluginRuntimeDependencies({
      rootDir: PROJECT_ROOT,
      outDir,
      allowedHostDirs: ["core", "lib", "shared", "server"],
    });
    transpilePackagedRuntimeTypeScript({ outDir });

    expect(fs.existsSync(path.join(outDir, "shared", "app-root.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "lib", "debug-log.js"))).toBe(true);
    expect(validatePackagedRuntimeImports({ outDir })).toMatchObject({ missing: [] });

    await expect(import(pathToFileURL(path.join(outDir, "lib", "i18n.js")).href)).resolves.toBeTruthy();
    await expect(import(pathToFileURL(path.join(outDir, "plugins", "image-gen", "index.js")).href)).resolves.toBeTruthy();

    const bus = new EventBus();
    const pm = new PluginManager({
      pluginsDir: packagedPluginsDir,
      dataDir: path.join(tempDir, "plugin-data"),
      bus,
    });
    pm.scan();
    await pm.loadAll();

    expect(pm.getPlugin("image-gen")?.status).toBe("loaded");
    expect(pm.getAllTools().map((tool) => tool.name)).toContain("image-gen_generate-image");
  });

  it("collects npm packages imported by bundled plugin source for packaged server installs", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "beautify", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "beautify", "index.js"),
      'import "./lib/markdown-cover-service.js";\nexport default class Beautify {}\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "plugins", "beautify", "lib", "markdown-cover-service.js"),
      'import YAML from "js-yaml";\nexport function parse(value) { return YAML.load(value); }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "node_modules", "js-yaml"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "js-yaml", "package.json"),
      JSON.stringify({ name: "js-yaml", version: "4.1.0", main: "index.js" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "js-yaml", "index.js"),
      "export default { load() { return {}; } };\n",
      "utf-8",
    );

    await expect(collectBundledPluginPackageDependencies({ rootDir }))
      .resolves.toContain("js-yaml");
  });

  it("collects npm packages dynamically imported by TypeScript plugin source", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "office", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "office", "lib", "read-pdf.ts"),
      'export async function readPdfDocument(filePath: string) { const pdf = await import("unpdf"); return pdf.getDocumentProxy(filePath); }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "node_modules", "unpdf"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "unpdf", "package.json"),
      JSON.stringify({ name: "unpdf", version: "1.6.2", exports: "./index.js" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "unpdf", "index.js"),
      "export function getDocumentProxy() { return {}; }\n",
      "utf-8",
    );

    await expect(collectBundledPluginPackageDependencies({ rootDir }))
      .resolves.toContain("unpdf");
  });

  it("treats inaccessible readlink probes as non-symlinks during nft tracing", async () => {
    const readlink = createTraceReadlink(async () => {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    });

    await expect(readlink("C:\\Users\\ghost\\.ssh\\config")).resolves.toBeNull();
  });

  it("does not let nft file IO read outside the project root", async () => {
    const outsidePath = path.join(tempDir, "outside.js");
    const traceFs = createTraceFileSystem(rootDir, {
      readlink: async () => {
        throw new Error("readlink should not be called");
      },
      readFile: async () => {
        throw new Error("readFile should not be called");
      },
      stat: async () => {
        throw new Error("stat should not be called");
      },
    });

    await expect(traceFs.readlink(outsidePath)).resolves.toBeNull();
    await expect(traceFs.readFile(outsidePath)).resolves.toBeNull();
    await expect(traceFs.stat(outsidePath)).resolves.toBeNull();
  });

  it("ignores external absolute paths reported by nft on Windows", () => {
    const ignore = createTraceIgnore();

    expect(ignore("C:\\Users\\ghost\\OneDrive\\locked-file")).toBe(true);
    expect(ignore("C:/Users/ghost/OneDrive/locked-file")).toBe(true);
    expect(ignore("\\\\server\\share\\locked-file")).toBe(true);
    expect(ignore("/outside/locked-file")).toBe(true);
    expect(ignore("../outside/locked-file")).toBe(true);
    expect(ignore("plugins/demo/index.js")).toBe(false);
  });

  it("rejects plugin imports into host paths that are not explicit runtime surfaces", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "bad"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "bad", "index.js"),
      'import "../../server/private.js";\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "server"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "server", "private.js"), "export {};\n", "utf-8");

    await expect(collectBundledPluginRuntimeDependencies({ rootDir }))
      .rejects.toThrow(/server[/\\]private\.js/);
  });
});
