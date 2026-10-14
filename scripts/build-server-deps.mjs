import fs from "fs";
import path from "path";

function getLockedPackageVersion(rootLock, packageName) {
  const packagePath = `node_modules/${packageName}`;
  const lockedPackage = rootLock?.packages?.[packagePath];
  if (!lockedPackage?.version) {
    throw new Error(`[build-server] package-lock.json does not contain ${packagePath}`);
  }
  return lockedPackage.version;
}

export function buildExternalPackage(
  rootPkg,
  externalDeps,
  { rootLock, pinnedTransitiveDeps = [], packageName = "codia-server" } = {},
) {
  const dependencies = {};

  for (const [dependencyName, requestedVersion] of Object.entries(externalDeps)) {
    dependencies[dependencyName] = rootLock
      ? getLockedPackageVersion(rootLock, dependencyName)
      : requestedVersion;
  }

  for (const dependencyName of pinnedTransitiveDeps) {
    dependencies[dependencyName] = getLockedPackageVersion(rootLock, dependencyName);
  }

  return {
    name: packageName,
    version: rootPkg.version,
    type: "module",
    dependencies,
    overrides: rootPkg.overrides || {},
  };
}

export function buildBetterSqliteRuntimeSmokeScript() {
  return [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(new URL('./package.json', import.meta.url));",
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "try {",
    "  const row = db.prepare('select 1 as ok').get();",
    "  if (row?.ok !== 1) {",
    "    throw new Error(`better-sqlite3 runtime smoke failed: ${JSON.stringify(row)}`);",
    "  }",
    "} finally {",
    "  db.close();",
    "}",
    "console.log('[build-server] better-sqlite3 runtime smoke passed');",
    "",
  ].join("\n");
}

function collectRuntimeExportTargets(exportValue, targets = []) {
  if (typeof exportValue === "string") {
    targets.push(exportValue);
    return targets;
  }

  if (!exportValue || typeof exportValue !== "object") {
    return targets;
  }

  for (const [condition, value] of Object.entries(exportValue)) {
    // `types` and the non-standard `source` condition are development-time
    // entries. Node's packaged runtime resolves `import`/`require`/`default`.
    if (condition === "types" || condition === "source") continue;
    collectRuntimeExportTargets(value, targets);
  }

  return targets;
}

function getRootExport(exportsField) {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return exportsField;
  }

  if (Object.hasOwn(exportsField, ".")) {
    return exportsField["."];
  }

  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.some((key) => key.startsWith("."));
  return isSubpathMap ? undefined : exportsField;
}

export function verifyExternalEntrypoints(outDir, packageNames) {
  const failures = [];

  for (const packageName of packageNames) {
    const packageDir = path.join(outDir, "node_modules", packageName);
    const packageJsonPath = path.join(packageDir, "package.json");

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const rootExport = getRootExport(pkg.exports);
      const targets = rootExport === undefined
        ? [pkg.main, pkg.module].filter(Boolean)
        : collectRuntimeExportTargets(rootExport);

      for (const target of targets) {
        if (typeof target !== "string" || !target.startsWith("./") || target.includes("*")) {
          continue;
        }

        const targetPath = path.join(packageDir, target);
        if (!fs.existsSync(targetPath)) {
          failures.push(`${packageName}: ${target} resolves to missing file ${targetPath}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${packageName}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error([
      "[build-server] external package entrypoint verification failed:",
      ...failures.map((failure) => `  - ${failure}`),
    ].join("\n"));
  }
}
