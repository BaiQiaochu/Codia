import fs from "fs";
import path from "path";
import { builtinModules } from "module";
import { nodeFileTrace } from "@vercel/nft";
import { transformSync } from "esbuild";

export const BUNDLED_PLUGIN_ALLOWED_HOST_DIRS = ["core", "lib", "shared"];

const BUILTIN_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const PLUGIN_RUNTIME_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const PLUGIN_TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const IGNORED_RUNTIME_DIRS = new Set(["tests", "__tests__", "node_modules"]);
const READLINK_PROBE_MISS_CODES = new Set(["EINVAL", "ENOENT", "UNKNOWN", "EPERM", "EACCES"]);

function isInsideRoot(rootDir, targetPath) {
  const relative = path.relative(rootDir, path.resolve(targetPath));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isOutsideTracePath(tracePath) {
  return path.isAbsolute(tracePath) || tracePath === ".." || tracePath.startsWith("../") || tracePath.startsWith("..\\");
}

export function createTraceReadlink(readlinkImpl = fs.promises.readlink) {
  return async function traceReadlink(targetPath) {
    try {
      return await readlinkImpl(targetPath);
    } catch (error) {
      if (READLINK_PROBE_MISS_CODES.has(error?.code)) return null;
      throw error;
    }
  };
}

export function createTraceFileSystem(rootDir, fsPromises = fs.promises) {
  const resolvedRootDir = path.resolve(rootDir);
  const readlink = createTraceReadlink(fsPromises.readlink.bind(fsPromises));

  return {
    async readlink(targetPath) {
      if (!isInsideRoot(resolvedRootDir, targetPath)) return null;
      return readlink(targetPath);
    },
    async readFile(targetPath) {
      if (!isInsideRoot(resolvedRootDir, targetPath)) return null;
      const resolved = resolveRuntimeSourcePath(targetPath);
      if (resolved?.transpile) {
        const source = await fsPromises.readFile(resolved.sourcePath, "utf8");
        return Buffer.from(transformTypeScriptRuntime(source, targetPath));
      }
      try {
        return await fsPromises.readFile(resolved?.sourcePath || targetPath);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
        throw error;
      }
    },
    async stat(targetPath) {
      if (!isInsideRoot(resolvedRootDir, targetPath)) return null;
      const resolved = resolveRuntimeSourcePath(targetPath);
      try {
        return await fsPromises.stat(resolved?.sourcePath || targetPath);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

export function createTraceIgnore({ ignoreNodeModules = false } = {}) {
  return function traceIgnore(tracePath) {
    if (isOutsideTracePath(tracePath)) return true;
    return ignoreNodeModules && isNodeModulesRelativePath(tracePath);
  };
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function toNativeRelativePath(value) {
  return value.split("/").join(path.sep);
}

function isNodeModulesRelativePath(relativePath) {
  return relativePath.split(/[\\/]/).includes("node_modules");
}

function packageNameFromNodeModulesPath(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  const index = parts.indexOf("node_modules");
  if (index < 0) return null;
  const first = parts[index + 1];
  if (!first) return null;
  if (!first.startsWith("@")) return first;
  const second = parts[index + 2];
  return second ? `${first}/${second}` : null;
}

function packageNameFromRuntimeSpecifier(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || BUILTIN_MODULES.has(specifier)) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] || null;
}

function hasRuntimeSourceParent(reason) {
  if (!reason?.parents || typeof reason.parents[Symbol.iterator] !== "function") return false;
  for (const parent of reason.parents) {
    if (!parent) continue;
    if (parent === "package.json") continue;
    if (!isNodeModulesRelativePath(parent)) return true;
  }
  return false;
}

function isPluginRuntimeEntry(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => IGNORED_RUNTIME_DIRS.has(part))) return false;
  const base = parts.at(-1) || "";
  if (/\.(?:test|spec)\.[cm]?[jt]s$/i.test(base)) return false;
  return PLUGIN_RUNTIME_EXTENSIONS.has(path.extname(base));
}

function isDeclarationTypeScriptFile(fileName) {
  return /\.d\.[cm]?ts$/i.test(fileName) || fileName.endsWith(".d.ts");
}

function outputExtensionForTypeScript(ext) {
  if (ext === ".mts") return ".mjs";
  if (ext === ".cts") return ".cjs";
  return ".js";
}

function runtimePathForTypeScriptSourcePath(sourcePath) {
  const ext = path.extname(sourcePath);
  if (!PLUGIN_TYPESCRIPT_EXTENSIONS.has(ext)) return sourcePath;
  return sourcePath.slice(0, -ext.length) + outputExtensionForTypeScript(ext);
}

function typeScriptSourcePathForRuntimePath(runtimePath) {
  const ext = path.extname(runtimePath);
  if (ext === ".mjs") return runtimePath.slice(0, -ext.length) + ".mts";
  if (ext === ".cjs") return runtimePath.slice(0, -ext.length) + ".cts";
  if (ext === ".js") return runtimePath.slice(0, -ext.length) + ".ts";
  return "";
}

function resolveRuntimeSourcePath(runtimePath) {
  if (fs.existsSync(runtimePath)) return { sourcePath: runtimePath, transpile: false };
  const tsPath = typeScriptSourcePathForRuntimePath(runtimePath);
  if (tsPath && fs.existsSync(tsPath)) return { sourcePath: tsPath, transpile: true };
  return null;
}

function runtimePathForTracedDependency(relativePath) {
  return runtimePathForTypeScriptSourcePath(relativePath);
}

const RUNTIME_IMPORT_SPECIFIER_RE =
  /^\s*import\s+(?:[^'";]*?\s+from\s*)?["']([^"']+)["']|^\s*export\s+[^'";]*?\s+from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gm;

function collectRuntimeImportSpecifiers(source) {
  const specifiers = [];
  for (const match of String(source).matchAll(RUNTIME_IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] || match[2] || match[3] || match[4] || "";
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function runtimeImportCandidates(basePath) {
  if (path.extname(basePath)) return [basePath];
  const extensions = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
  return [
    ...extensions.map((ext) => `${basePath}${ext}`),
    ...extensions.map((ext) => path.join(basePath, `index${ext}`)),
  ];
}

function resolveRelativeRuntimeImport(rootDir, importerRelativePath, specifier) {
  if (!specifier.startsWith(".")) return null;

  const basePath = path.normalize(path.join(path.dirname(importerRelativePath), specifier));
  if (isOutsideTracePath(toPosixPath(basePath))) return null;

  for (const candidate of runtimeImportCandidates(basePath)) {
    const resolved = resolveRuntimeSourcePath(path.join(rootDir, candidate));
    if (!resolved) continue;
    return runtimePathForTracedDependency(candidate);
  }
  return null;
}

function collectTransitiveHostRuntimeDependencies({ rootDir, dependencies, allowedHostDirs }) {
  const result = new Set();
  const queue = [];

  function add(relativePath) {
    const normalized = path.normalize(relativePath);
    if (result.has(normalized)) return;
    assertAllowedHostDependency(normalized, allowedHostDirs);
    result.add(normalized);
    queue.push(normalized);
  }

  for (const dependency of dependencies) add(dependency);

  while (queue.length > 0) {
    const relativePath = queue.shift();
    const resolved = resolveRuntimeSourcePath(path.join(rootDir, relativePath));
    if (!resolved) continue;

    const source = fs.readFileSync(resolved.sourcePath, "utf8");
    for (const specifier of collectRuntimeImportSpecifiers(source)) {
      const child = resolveRelativeRuntimeImport(rootDir, relativePath, specifier);
      if (child) add(child);
    }
  }

  return [...result].sort();
}

function collectDeclaredHostRuntimeDependenciesFromPlugins({ rootDir, allowedHostDirs }) {
  const result = new Set();
  const visited = new Set();
  const queue = listPluginRuntimeEntries(rootDir)
    .map((entry) => runtimePathForTracedDependency(path.relative(rootDir, entry)));

  while (queue.length > 0) {
    const relativePath = path.normalize(queue.shift());
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);

    const resolved = resolveRuntimeSourcePath(path.join(rootDir, relativePath));
    if (!resolved) continue;

    const source = fs.readFileSync(resolved.sourcePath, "utf8");
    for (const specifier of collectRuntimeImportSpecifiers(source)) {
      const child = resolveRelativeRuntimeImport(rootDir, relativePath, specifier);
      if (!child) continue;
      if (child.split(/[\\/]/)[0] === "plugins") {
        queue.push(child);
        continue;
      }
      assertAllowedHostDependency(child, allowedHostDirs);
      result.add(child);
    }
  }

  return result;
}

function transformTypeScriptRuntime(source, runtimePath) {
  const ext = path.extname(runtimePath);
  const output = transformSync(source, {
    loader: "ts",
    format: ext === ".cjs" ? "cjs" : "esm",
    target: "node24",
    sourcemap: false,
  }).code;
  return rewriteTypeScriptImportSpecifiers(output);
}

function runtimeExtensionForTypeScriptImport(ext) {
  if (ext === "mts") return "mjs";
  if (ext === "cts") return "cjs";
  return "js";
}

export function rewriteTypeScriptImportSpecifiers(source) {
  return String(source)
    .replace(/\b(from\s*["'])(\.[^"']+)\.(ts|mts|cts)(["'])/g, (_match, head, spec, ext, tail) => {
      return `${head}${spec}.${runtimeExtensionForTypeScriptImport(ext)}${tail}`;
    })
    .replace(/\b(import\s*["'])(\.[^"']+)\.(ts|mts|cts)(["'])/g, (_match, head, spec, ext, tail) => {
      return `${head}${spec}.${runtimeExtensionForTypeScriptImport(ext)}${tail}`;
    })
    .replace(/\b(import\s*\(\s*["'])(\.[^"']+)\.(ts|mts|cts)(["'])/g, (_match, head, spec, ext, tail) => {
      return `${head}${spec}.${runtimeExtensionForTypeScriptImport(ext)}${tail}`;
    })
    .replace(/\b(require\s*\(\s*["'])(\.[^"']+)\.(ts|mts|cts)(["'])/g, (_match, head, spec, ext, tail) => {
      return `${head}${spec}.${runtimeExtensionForTypeScriptImport(ext)}${tail}`;
    });
}

export function copyOrTranspileRuntimeDependency({ rootDir, outDir, relativePath } = {}) {
  if (!rootDir) throw new Error("[build-server] copyOrTranspileRuntimeDependency requires rootDir");
  if (!outDir) throw new Error("[build-server] copyOrTranspileRuntimeDependency requires outDir");
  if (!relativePath) throw new Error("[build-server] copyOrTranspileRuntimeDependency requires relativePath");

  const runtimePath = path.join(rootDir, relativePath);
  const sourceExt = path.extname(relativePath);
  if (PLUGIN_TYPESCRIPT_EXTENSIONS.has(sourceExt)) {
    const sourcePath = path.join(rootDir, relativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`[build-server] runtime dependency source not found: ${relativePath}`);
    }
    const outputRelativePath = runtimePathForTypeScriptSourcePath(relativePath);
    const target = path.join(outDir, outputRelativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(target, transformTypeScriptRuntime(source, path.join(rootDir, outputRelativePath)), "utf8");
    return outputRelativePath;
  }

  const resolved = resolveRuntimeSourcePath(runtimePath);
  if (!resolved) {
    throw new Error(`[build-server] runtime dependency source not found: ${relativePath}`);
  }

  const target = path.join(outDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (resolved.transpile) {
    const source = fs.readFileSync(resolved.sourcePath, "utf8");
    fs.writeFileSync(target, transformTypeScriptRuntime(source, runtimePath), "utf8");
  } else {
    const ext = path.extname(target);
    if ([".js", ".mjs", ".cjs"].includes(ext)) {
      const source = fs.readFileSync(resolved.sourcePath, "utf8");
      fs.writeFileSync(target, rewriteTypeScriptImportSpecifiers(source), "utf8");
    } else {
      fs.copyFileSync(resolved.sourcePath, target);
    }
  }
  return relativePath;
}

export function transpileBundledPluginTypeScript({ pluginsDir } = {}) {
  if (!pluginsDir) throw new Error("[build-server] transpileBundledPluginTypeScript requires pluginsDir");
  if (!fs.existsSync(pluginsDir)) return [];

  const outputs = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_RUNTIME_DIRS.has(entry.name)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isDeclarationTypeScriptFile(entry.name)) continue;
      const ext = path.extname(entry.name);
      if (!PLUGIN_TYPESCRIPT_EXTENSIONS.has(ext)) continue;

      const source = fs.readFileSync(fullPath, "utf8");
      const result = transformSync(source, {
        loader: "ts",
        format: ext === ".cts" ? "cjs" : "esm",
        target: "node24",
        sourcemap: false,
      });
      const targetPath = path.join(dir, `${path.basename(entry.name, ext)}${outputExtensionForTypeScript(ext)}`);
      fs.writeFileSync(targetPath, rewriteTypeScriptImportSpecifiers(result.code), "utf8");
      fs.rmSync(fullPath, { force: true });
      outputs.push(path.relative(pluginsDir, targetPath));
    }
  }

  visit(pluginsDir);

  function rewriteJavaScriptFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_RUNTIME_DIRS.has(entry.name)) continue;
        rewriteJavaScriptFiles(fullPath);
        continue;
      }
      if (!entry.isFile() || ![".js", ".mjs", ".cjs"].includes(path.extname(entry.name))) continue;
      const source = fs.readFileSync(fullPath, "utf8");
      const rewritten = rewriteTypeScriptImportSpecifiers(source);
      if (rewritten !== source) fs.writeFileSync(fullPath, rewritten, "utf8");
    }
  }

  rewriteJavaScriptFiles(pluginsDir);
  return outputs.sort();
}

export function transpilePackagedRuntimeTypeScript({
  outDir,
  roots = ["core", "lib", "server", "shared"],
} = {}) {
  if (!outDir) throw new Error("[build-server] transpilePackagedRuntimeTypeScript requires outDir");

  const outputs = [];

  function visit(dir, rootDir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_RUNTIME_DIRS.has(entry.name)) continue;
        visit(fullPath, rootDir);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isDeclarationTypeScriptFile(entry.name)) continue;
      const ext = path.extname(entry.name);
      if (!PLUGIN_TYPESCRIPT_EXTENSIONS.has(ext)) continue;

      const outputPath = runtimePathForTypeScriptSourcePath(fullPath);
      const source = fs.readFileSync(fullPath, "utf8");
      fs.writeFileSync(outputPath, transformTypeScriptRuntime(source, outputPath), "utf8");
      outputs.push(path.relative(outDir, outputPath));
    }
  }

  for (const root of roots) {
    visit(path.join(outDir, root), path.join(outDir, root));
  }

  return outputs.sort();
}

function listPluginRuntimeEntries(rootDir) {
  const pluginsDir = path.join(rootDir, "plugins");
  if (!fs.existsSync(pluginsDir)) return [];
  const entries = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(pluginsDir, fullPath);
      if (entry.isDirectory()) {
        if (IGNORED_RUNTIME_DIRS.has(entry.name)) continue;
        visit(fullPath);
      } else if (entry.isFile() && isPluginRuntimeEntry(relative)) {
        entries.push(fullPath);
      }
    }
  }

  visit(pluginsDir);
  return entries.sort();
}

function assertAllowedHostDependency(relativePath, allowedHostDirs) {
  const topLevelDir = relativePath.split(/[\\/]/)[0];
  if (allowedHostDirs.includes(topLevelDir)) return;
  throw new Error(
    `[build-server] bundled plugin imports unsupported host runtime dependency: ${relativePath}. `
      + `Allowed roots: ${allowedHostDirs.join(", ")}`,
  );
}

export async function collectBundledPluginRuntimeDependencies({
  rootDir,
  allowedHostDirs = BUNDLED_PLUGIN_ALLOWED_HOST_DIRS,
} = {}) {
  if (!rootDir) throw new Error("[build-server] collectBundledPluginRuntimeDependencies requires rootDir");
  const pluginEntries = listPluginRuntimeEntries(rootDir);
  if (pluginEntries.length === 0) return [];
  const traceFs = createTraceFileSystem(rootDir);

  const { fileList } = await nodeFileTrace(pluginEntries, {
    base: rootDir,
    conditions: ["node", "import"],
    ignore: createTraceIgnore({ ignoreNodeModules: true }),
    ...traceFs,
  });

  const dependencies = new Set();
  for (const declaredDependency of collectDeclaredHostRuntimeDependenciesFromPlugins({ rootDir, allowedHostDirs })) {
    dependencies.add(declaredDependency);
  }

  for (const tracedFile of fileList) {
    const relative = toPosixPath(tracedFile);
    if (!relative || relative === "package.json") continue;
    if (relative.startsWith("plugins/") || relative.startsWith("node_modules/")) continue;

    const nativeRelative = runtimePathForTracedDependency(toNativeRelativePath(relative));
    assertAllowedHostDependency(nativeRelative, allowedHostDirs);
    dependencies.add(nativeRelative);
  }

  return collectTransitiveHostRuntimeDependencies({
    rootDir,
    dependencies,
    allowedHostDirs,
  });
}

export async function collectBundledPluginPackageDependencies({ rootDir } = {}) {
  if (!rootDir) throw new Error("[build-server] collectBundledPluginPackageDependencies requires rootDir");
  const pluginEntries = listPluginRuntimeEntries(rootDir);
  if (pluginEntries.length === 0) return [];
  const traceFs = createTraceFileSystem(rootDir);

  const { fileList, reasons } = await nodeFileTrace(pluginEntries, {
    base: rootDir,
    conditions: ["node", "import"],
    ignore: createTraceIgnore(),
    ...traceFs,
  });

  const packages = new Set();
  for (const entry of pluginEntries) {
    const relativePath = path.relative(rootDir, entry);
    const resolved = resolveRuntimeSourcePath(path.join(rootDir, relativePath));
    if (!resolved) continue;
    const source = fs.readFileSync(resolved.sourcePath, "utf8");
    for (const specifier of collectRuntimeImportSpecifiers(source)) {
      const packageName = packageNameFromRuntimeSpecifier(specifier);
      if (packageName) packages.add(packageName);
    }
  }

  for (const tracedFile of fileList) {
    const relative = toPosixPath(tracedFile);
    const packageName = packageNameFromNodeModulesPath(relative);
    if (!packageName) continue;
    const reason = reasons?.get?.(tracedFile) || reasons?.get?.(relative);
    if (!hasRuntimeSourceParent(reason)) continue;
    packages.add(packageName);
  }

  return [...packages].sort();
}

export async function copyBundledPluginRuntimeDependencies({
  rootDir,
  outDir,
  allowedHostDirs = BUNDLED_PLUGIN_ALLOWED_HOST_DIRS,
} = {}) {
  if (!outDir) throw new Error("[build-server] copyBundledPluginRuntimeDependencies requires outDir");
  const dependencies = await collectBundledPluginRuntimeDependencies({ rootDir, allowedHostDirs });

  for (const relativePath of dependencies) {
    copyOrTranspileRuntimeDependency({ rootDir, outDir, relativePath });
  }

  return dependencies;
}

function isIgnoredPackagedRuntimeDir(dirName) {
  return dirName === "node_modules" || dirName === ".bin";
}

function listPackagedRuntimeJavaScriptFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isIgnoredPackagedRuntimeDir(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  visit(rootDir);
  return files.sort();
}

function resolvePackagedRuntimeImport(importerPath, specifier) {
  const target = path.resolve(path.dirname(importerPath), specifier);
  if (path.extname(target)) return [target];
  return [
    `${target}.js`,
    `${target}.mjs`,
    `${target}.cjs`,
    path.join(target, "index.js"),
    path.join(target, "index.mjs"),
    path.join(target, "index.cjs"),
  ];
}

export function validatePackagedRuntimeImports({ outDir, fsImpl = fs } = {}) {
  if (!outDir) throw new Error("[build-server] validatePackagedRuntimeImports requires outDir");
  const missing = [];
  const rootDir = path.resolve(outDir);

  for (const filePath of listPackagedRuntimeJavaScriptFiles(rootDir)) {
    const source = fsImpl.readFileSync(filePath, "utf8");
    for (const specifier of collectRuntimeImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const candidates = resolvePackagedRuntimeImport(filePath, specifier);
      if (candidates.some((candidate) => fsImpl.existsSync(candidate))) continue;
      missing.push({
        importer: path.relative(rootDir, filePath),
        specifier,
        expected: path.relative(rootDir, candidates[0]),
      });
    }
  }

  if (missing.length > 0) {
    const details = missing
      .slice(0, 30)
      .map((item) => `${item.importer} imports ${item.specifier} (expected ${item.expected})`)
      .join("\n");
    const suffix = missing.length > 30 ? `\n...and ${missing.length - 30} more missing imports` : "";
    throw new Error(`[build-server] packaged runtime has missing relative imports:\n${details}${suffix}`);
  }

  return { checkedFiles: listPackagedRuntimeJavaScriptFiles(rootDir).length, missing: [] };
}
