const path = require("path");

function resolveRealFs(requireFn = require) {
  try {
    return requireFn("original-fs");
  } catch {
    return requireFn("fs");
  }
}

const fs = resolveRealFs();

function canRead(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const filePath of paths) {
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    result.push(filePath);
  }
  return result;
}

function unpackedAppRequiredFiles(appRoot) {
  if (!appRoot) return [];
  return [
    path.join(appRoot, "package.json"),
    path.join(appRoot, "desktop", "bootstrap.cjs"),
    path.join(appRoot, "desktop", "main.bundle.cjs"),
    path.join(appRoot, "desktop", "preload.bundle.cjs"),
    path.join(appRoot, "desktop", "dist-renderer", "index.html"),
  ];
}

function isReadableUnpackedApp(appRoot) {
  const files = unpackedAppRequiredFiles(appRoot);
  return files.length > 0 && files.every(canRead);
}

function buildDesktopAppPayloadCheck({ resourcesRoot, appPath } = {}) {
  const asarPath = path.join(resourcesRoot, "app.asar");
  const appRoots = uniquePaths([
    appPath && !String(appPath).toLowerCase().endsWith(".asar") ? appPath : "",
    path.join(resourcesRoot, "app"),
  ]);
  const unpackedFiles = appRoots.flatMap(unpackedAppRequiredFiles);

  return {
    id: "desktop-app",
    label: "packaged desktop app",
    relativePath: "resources/app.asar or resources/app",
    paths: uniquePaths([asarPath, ...unpackedFiles]),
    exists: () => canRead(asarPath) || appRoots.some(isReadableUnpackedApp),
  };
}

function direntType(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function inspectDirectoryEntries(dirPath, maxEntries = 40) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .map(entry => ({
        name: entry.name,
        type: direntType(entry),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      entries: entries.slice(0, maxEntries),
      truncated: entries.length > maxEntries,
      entryCount: entries.length,
    };
  } catch (err) {
    return {
      entries: [],
      truncated: false,
      entryCount: null,
      error: {
        code: err?.code || null,
        message: err?.message || String(err),
      },
    };
  }
}

function inspectInstallPath({ filePath, relativePath, listEntries = false, maxEntries = 40 }) {
  const base = {
    relativePath,
    path: normalizeSlashes(filePath),
    exists: false,
    readable: false,
    type: "missing",
  };

  try {
    const stat = fs.statSync(filePath);
    const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    const result = {
      ...base,
      exists: true,
      readable: canRead(filePath),
      type,
      size: stat.isFile() ? stat.size : null,
    };
    if (listEntries && stat.isDirectory()) {
      return {
        ...result,
        ...inspectDirectoryEntries(filePath, maxEntries),
      };
    }
    return result;
  } catch (err) {
    return {
      ...base,
      error: err?.code || null,
    };
  }
}

function buildWindowsInstallSurfaceContext({ execPath, resourcesPath } = {}) {
  const executablePath = execPath || "";
  const appRoot = executablePath ? path.dirname(executablePath) : "";
  const resourcesRoot = resourcesPath || (appRoot ? path.join(appRoot, "resources") : "");
  return {
    appRoot: normalizeSlashes(appRoot),
    resourcesRoot: normalizeSlashes(resourcesRoot),
    appAsar: inspectInstallPath({
      filePath: path.join(resourcesRoot, "app.asar"),
      relativePath: "resources/app.asar",
    }),
    legacyAppDirectory: inspectInstallPath({
      filePath: path.join(resourcesRoot, "app"),
      relativePath: "resources/app",
      listEntries: true,
      maxEntries: 40,
    }),
    resourcesDirectory: inspectInstallPath({
      filePath: resourcesRoot,
      relativePath: "resources",
      listEntries: true,
      maxEntries: 80,
    }),
  };
}

function buildWindowsInstallSurfaceChecks(opts = {}) {
  const { execPath, resourcesPath, appPath } = opts;
  const executablePath = execPath || "";
  const appRoot = executablePath ? path.dirname(executablePath) : "";
  const resourcesRoot = resourcesPath || (appRoot ? path.join(appRoot, "resources") : "");
  const serverRoot = path.join(resourcesRoot, "server");
  const gitRoot = path.join(resourcesRoot, "git");
  const gitExe = path.join(gitRoot, "cmd", "git.exe");
  const shellCandidates = [
    path.join(gitRoot, "bin", "bash.exe"),
    path.join(gitRoot, "usr", "bin", "bash.exe"),
    path.join(gitRoot, "usr", "bin", "sh.exe"),
    path.join(gitRoot, "mingw64", "bin", "busybox.exe"),
  ];

  return [
    {
      id: "codia-exe",
      label: "desktop application executable",
      relativePath: "desktop application executable",
      paths: [executablePath],
      exists: () => !!executablePath && canRead(executablePath),
    },
    buildDesktopAppPayloadCheck({ resourcesRoot, appPath }),
    {
      id: "server-exe",
      label: "resources/server/codia-server.exe",
      relativePath: "resources/server/codia-server.exe or resources/server/codia-server.exe",
      paths: [path.join(serverRoot, "codia-server.exe"), path.join(serverRoot, "codia-server.exe")],
    },
    {
      id: "server-bootstrap",
      label: "resources/server/bootstrap.js",
      relativePath: "resources/server/bootstrap.js",
      paths: [path.join(serverRoot, "bootstrap.js")],
    },
    {
      id: "server-bundle",
      label: "resources/server/bundle/index.js",
      relativePath: "resources/server/bundle/index.js",
      paths: [path.join(serverRoot, "bundle", "index.js")],
    },
    {
      id: "better-sqlite3-native",
      label: "better-sqlite3 native addon",
      relativePath: "resources/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      paths: [path.join(serverRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")],
    },
    {
      id: "portable-git",
      label: "PortableGit",
      relativePath: "resources/git",
      paths: [gitExe, ...shellCandidates],
      exists: () => canRead(gitExe) && shellCandidates.some(canRead),
    },
  ];
}

function serializeCheck(item) {
  const exists = typeof item.exists === "function"
    ? item.exists()
    : item.paths.some(canRead);
  return {
    id: item.id,
    label: item.label,
    relativePath: item.relativePath,
    paths: item.paths.map(normalizeSlashes),
    exists,
  };
}

function checkWindowsInstallSurface(opts = {}) {
  const checked = buildWindowsInstallSurfaceChecks(opts).map(serializeCheck);
  const missing = checked.filter(item => !item.exists);
  return {
    ok: missing.length === 0,
    checked,
    missing,
    context: buildWindowsInstallSurfaceContext(opts),
  };
}

function writeLaunchDiagnostic({
  diagnosticsDir,
  fileName,
  event,
  payload,
  now = new Date(),
}) {
  if (!diagnosticsDir || !fileName) {
    throw new Error("writeLaunchDiagnostic: diagnosticsDir and fileName are required");
  }
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    event,
    time: now instanceof Date ? now.toISOString() : String(now),
    payload,
  }, null, 2) + "\n", "utf-8");
  return filePath;
}

function appendLaunchLog({ diagnosticsDir, event, payload, now = new Date() }) {
  if (!diagnosticsDir) return null;
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, "launch.log");
  fs.appendFileSync(filePath, JSON.stringify({
    event,
    time: now instanceof Date ? now.toISOString() : String(now),
    payload,
  }) + "\n", "utf-8");
  return filePath;
}

function formatInstallSurfaceError(result, diagnosticPath) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  const lines = missing.map(item => `- ${item.relativePath}`);
  const diagnosticLine = diagnosticPath ? `\n\nDiagnostic file:\n${diagnosticPath}` : "";
  return [
    "The application installation is incomplete.",
    "",
    "Missing or unreadable files:",
    ...lines,
    diagnosticLine.trimEnd(),
  ].filter(Boolean).join("\n");
}

module.exports = {
  appendLaunchLog,
  buildWindowsInstallSurfaceContext,
  buildWindowsInstallSurfaceChecks,
  checkWindowsInstallSurface,
  formatInstallSurfaceError,
  resolveRealFs,
  writeLaunchDiagnostic,
};
