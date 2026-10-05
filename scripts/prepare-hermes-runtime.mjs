import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HERMES_CACHE_VERSION = 4;
const DEFAULT_RUNTIME_EXTRAS = [
  "modal",
  "daytona",
  "vercel",
  "cli",
  "pty",
  "mcp",
  "messaging",
  "cron",
  "honcho",
  "acp",
  "web",
  "google",
  "mistral",
  "bedrock",
  "slack",
  "dingtalk",
  "feishu",
  "homeassistant",
  "sms",
  "tts-premium",
  "voice",
];

function pathExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function findPythonLauncher(platform) {
  const candidates = platform === "win32"
    ? [
        { command: "py", args: ["-3.12"] },
        { command: "py", args: ["-3.11"] },
        { command: "py", args: ["-3"] },
        { command: "python", args: [] },
      ]
    : [
        { command: "python3", args: [] },
        { command: "python", args: [] },
      ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, "-c", "import sys; print(sys.executable)"], {
        stdio: "ignore",
      });
      return candidate;
    } catch {
      // Try next launcher.
    }
  }

  throw new Error("No usable Python launcher found for Hermes runtime preparation");
}

function shouldIncludeHermesPath(srcRoot, src) {
  const EXCLUDED_DIRS = new Set([
    ".github",
    ".plans",
    "__pycache__",
    "datagen-config-examples",
    "docker",
    "docs",
    "hermes_agent.egg-info",
    "landingpage",
    "nix",
    "packaging",
    "plans",
    "tests",
    "tinker-atropos",
    "ui-tui",
    "web",
    "website",
    ".venv",
    "venv",
  ]);
  const EXCLUDED_FILES = [
    /^RELEASE_/i,
    /^CONTRIBUTING\.md$/i,
    /^package-lock\.json$/i,
    /^uv\.lock$/i,
  ];
  const EXCLUDED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".mp4"]);

  const rel = path.relative(srcRoot, src);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;

  const base = path.basename(src);
  if (EXCLUDED_FILES.some((re) => re.test(base))) return false;

  const ext = path.extname(base).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) return false;

  return true;
}

function shouldIncludePythonBasePath(baseRoot, src) {
  const rel = path.relative(baseRoot, src);
  if (!rel) return true;
  const normalized = rel.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const base = path.basename(src);

  if (parts.includes("__pycache__")) return false;
  if (normalized.startsWith("Lib/site-packages/")) return false;
  if (normalized.startsWith("Lib/test/")) return false;
  if (normalized.startsWith("Lib/ensurepip/")) return false;
  if (normalized.startsWith("Scripts/")) return false;
  if (/\.pyc$/i.test(base)) return false;

  return true;
}

function copyHermesSource(srcRoot, destRoot) {
  fs.cpSync(srcRoot, destRoot, {
    recursive: true,
    force: true,
    filter: (src) => shouldIncludeHermesPath(srcRoot, src),
  });
}

function hashTree(rootDir, shouldInclude, extra = {}) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(extra));

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (!shouldInclude(rootDir, fullPath)) continue;

      const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        walk(fullPath);
        continue;
      }

      const stat = fs.statSync(fullPath);
      hash.update(`file:${rel}:${stat.size}:${stat.mtimeMs}\n`);
    }
  }

  walk(rootDir);
  return hash.digest("hex");
}

function loadManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function getPythonRuntimeInfo(venvPython) {
  const script = [
    "import json, sys",
    "print(json.dumps({",
    "  'base_prefix': sys.base_prefix,",
    "  'prefix': sys.prefix,",
    "  'executable': sys.executable,",
    "  'version': '.'.join(map(str, sys.version_info[:3])),",
    "  'major': sys.version_info[0],",
    "  'minor': sys.version_info[1],",
    "}))",
  ].join("\n");
  return JSON.parse(execFileSync(venvPython, ["-c", script], { encoding: "utf8" }));
}

function copyPortablePythonRuntime({ venvPython, runtimeRoot, platform }) {
  if (platform !== "win32") return null;

  const info = getPythonRuntimeInfo(venvPython);
  const baseRoot = path.resolve(info.base_prefix || "");
  if (!baseRoot || !pathExists(path.join(baseRoot, "python.exe"))) {
    throw new Error(`Cannot locate Python base runtime for Hermes: ${baseRoot || "(empty)"}`);
  }

  const portableRoot = path.join(runtimeRoot, "python");
  fs.rmSync(portableRoot, { recursive: true, force: true });
  ensureDir(portableRoot);

  fs.cpSync(baseRoot, portableRoot, {
    recursive: true,
    force: true,
    filter: (src) => shouldIncludePythonBasePath(baseRoot, src),
  });

  const portablePython = path.join(portableRoot, "python.exe");
  if (!pathExists(portablePython)) {
    throw new Error(`Portable Hermes Python was not copied correctly: ${portablePython}`);
  }

  const pyvenvCfg = path.join(runtimeRoot, ".venv", "pyvenv.cfg");
  if (pathExists(pyvenvCfg)) {
    fs.writeFileSync(pyvenvCfg, [
      `home = ${portableRoot}`,
      "include-system-site-packages = false",
      `version = ${info.version}`,
      `executable = ${portablePython}`,
      `command = ${portablePython} -m venv ${path.join(runtimeRoot, ".venv")}`,
      "",
    ].join("\n"));
  }

  return {
    portableRoot,
    portablePython,
    version: info.version,
  };
}

function resolveRuntimeExtras() {
  const raw = String(process.env.HERMES_RUNTIME_EXTRAS || "").trim();
  if (!raw) return DEFAULT_RUNTIME_EXTRAS;
  if (/^(none|false|0)$/i.test(raw)) return [];
  if (/^(all|full)$/i.test(raw)) return ["all"];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function installHermesPackage({ venvPython, runtimeRoot, platform }) {
  const extras = resolveRuntimeExtras();
  const installTarget = extras.length > 0
    ? `${runtimeRoot}[${extras.join(",")}]`
    : runtimeRoot;

  execFileSync(venvPython, ["-m", "pip", "install", "-e", installTarget], {
    stdio: "inherit",
  });

  if (platform === "win32" && !extras.includes("pty") && !extras.includes("all")) {
    execFileSync(venvPython, ["-m", "pip", "install", "pywinpty>=2.0.0,<3"], {
      stdio: "inherit",
    });
  }

  return extras;
}

export function prepareHermesRuntime({ rootDir, outDir, platform }) {
  const sourceRoot = path.join(rootDir, "hermes-agent-main");
  if (!pathExists(sourceRoot)) {
    return { prepared: false, reason: "source-missing" };
  }

  const python = findPythonLauncher(platform);
  const runtimeRoot = path.join(outDir, "hermes-agent-runtime");
  const runtimeExtras = resolveRuntimeExtras();

  const cacheRoot = path.join(rootDir, ".cache", "runtime-prep", `hermes-${platform}`);
  const cacheRuntimeRoot = path.join(cacheRoot, "runtime");
  const manifestPath = path.join(cacheRoot, "manifest.json");
  const fingerprint = hashTree(sourceRoot, shouldIncludeHermesPath, {
    cacheVersion: HERMES_CACHE_VERSION,
    platform,
    python,
    runtimeExtras,
    runtimeRoot,
  });
  const manifest = loadManifest(manifestPath);
  const expectedPortablePython = platform === "win32"
    ? path.join(cacheRuntimeRoot, "python", "python.exe")
    : "";

  if (
    manifest?.fingerprint === fingerprint
    && manifest?.runtimeRoot === runtimeRoot
    && pathExists(path.join(cacheRuntimeRoot, ".venv"))
    && (platform !== "win32" || pathExists(expectedPortablePython))
  ) {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    ensureDir(path.dirname(runtimeRoot));
    fs.cpSync(cacheRuntimeRoot, runtimeRoot, { recursive: true, force: true });
    console.log("[prepare-hermes] using cached runtime");
    return {
      prepared: true,
      runtimeRoot,
      venvPython: platform === "win32"
        ? path.join(runtimeRoot, ".venv", "Scripts", "python.exe")
        : path.join(runtimeRoot, ".venv", "bin", "python"),
      portablePython: platform === "win32" ? path.join(runtimeRoot, "python", "python.exe") : null,
      cached: true,
    };
  }

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  ensureDir(runtimeRoot);
  copyHermesSource(sourceRoot, runtimeRoot);

  const venvDir = path.join(runtimeRoot, ".venv");
  execFileSync(python.command, [...python.args, "-m", "venv", venvDir], {
    stdio: "inherit",
  });

  const venvPython = platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");

  execFileSync(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], {
    stdio: "inherit",
  });

  const installedExtras = installHermesPackage({ venvPython, runtimeRoot, platform });
  const pythonRuntime = copyPortablePythonRuntime({ venvPython, runtimeRoot, platform });

  fs.rmSync(cacheRuntimeRoot, { recursive: true, force: true });
  ensureDir(cacheRoot);
  fs.cpSync(runtimeRoot, cacheRuntimeRoot, { recursive: true, force: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    cacheVersion: HERMES_CACHE_VERSION,
    fingerprint,
    runtimeRoot,
    platform,
    runtimeExtras: installedExtras,
    portablePython: pythonRuntime?.portablePython || null,
  }, null, 2));

  return {
    prepared: true,
    runtimeRoot,
    venvPython,
    portablePython: pythonRuntime?.portablePython || null,
    cached: false,
  };
}
