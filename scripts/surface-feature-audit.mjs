#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getBridgeCapabilityMatrix } from "../lib/bridge/capability-matrix.ts";
import { KNOWN_PLATFORMS } from "../lib/bridge/session-key.ts";

const args = process.argv.slice(2);
const reportPath = valueArg("--report");
const markdownPath = valueArg("--markdown");
const jsonOnly = args.includes("--json");
const ROOT = process.cwd();

const fileCache = new Map();
const matrix = getBridgeCapabilityMatrix();

const checks = [
  {
    id: "connector-configuration",
    title: "Connector configuration",
    desktop: [exists("desktop/src/react/settings/tabs/BridgeTab.tsx"), contains("desktop/src/react/settings/tabs/bridge/useBridgeState.ts", "/api/bridge/config")],
    pwa: [contains("desktop/src/react/settings/api.ts", "__GSAP_PWA__"), contains("scripts/launch.js", "GSAP_SERVER_SCOPE")],
    cli: [contains("lib/cli/bridge-status.ts", "readBridgeStatusSafe"), contains("lib/cli/bridge-status.ts", "/bridge/status")],
  },
  {
    id: "connector-diagnostics",
    title: "Connector diagnostics",
    desktop: [contains("desktop/src/react/settings/tabs/bridge/PlatformDiagnostics.tsx", "lastConnectedAt"), contains("desktop/src/react/settings/tabs/bridge/PlatformDiagnostics.tsx", "retryCount")],
    pwa: [contains("desktop/src/react/settings/tabs/bridge/useBridgeState.ts", "/api/bridge/status")],
    cli: [contains("lib/cli/bridge-status.ts", "formatBridgeCliSummary"), contains("lib/cli/bridge-status.ts", "formatBridgeCapabilityShort"), contains("lib/cli/bridge-status.ts", "formatBridgeDiagnosticsShort")],
  },
  {
    id: "media-sending",
    title: "Bridge media sending",
    desktop: [anyExists(["lib/bridge/media-delivery-service.ts", "lib/bridge/media-delivery-service.js"]), matrixHasMediaForAllPlatforms()],
    pwa: [contains("desktop/src/react/utils/browser-file-paths.ts", "uploadBrowserFiles"), anyExists(["server/routes/upload.ts", "server/routes/upload.js"])],
    cli: [contains("lib/cli/media.ts", "readImages"), contains("lib/cli/main.ts", "--image")],
  },
  {
    id: "file-upload",
    title: "File upload",
    desktop: [anyExists(["server/routes/upload.ts", "server/routes/upload.js"]), exists("shared/filename-sanitizer.ts")],
    pwa: [contains("desktop/src/react/utils/browser-file-paths.ts", "uploadBrowserFiles")],
    cli: [contains("lib/cli/media.ts", "readImages")],
  },
  {
    id: "settings",
    title: "Settings",
    desktop: [exists("desktop/src/react/settings"), contains("desktop/src/react/settings/tabs/BridgeTab.tsx", "PlatformSection")],
    pwa: [contains("desktop/src/react/settings/api.ts", "pwaBridge")],
    cli: [contains("lib/cli/main.ts", "commandModels"), contains("lib/cli/main.ts", "commandAgents")],
  },
  {
    id: "appearance-settings",
    title: "Appearance settings",
    desktop: [contains("desktop/src/react/settings/tabs/InterfaceTab.tsx", "theme-card"), contains("desktop/src/lib/theme.ts", "../shared/theme.ts")],
    pwa: [contains("desktop/src/mobile.html", "lib/theme.js"), contains("desktop/src/lib/theme.ts", "../shared/theme.ts")],
    cli: [
      notContains("lib/cli/main.ts", "theme"),
      notContains("lib/cli/main.ts", "appearance"),
      notContains("lib/cli/main.ts", "visual"),
    ],
  },
  {
    id: "session-recovery",
    title: "Session recovery",
    desktop: [anyExists(["server/routes/sessions.ts", "server/routes/sessions.js"]), containsAny(["core/bridge-session-manager.ts", "core/bridge-session-manager.js"], "readIndex")],
    pwa: [contains("desktop/src/react/hooks/use-gsap-fetch.ts", "serverUrl")],
    cli: [contains("lib/cli/main.ts", "commandSessions"), contains("lib/cli/main.ts", "sessions/switch")],
  },
  {
    id: "model-context-length",
    title: "Model context length",
    desktop: [anyExists(["core/model-token-limits.ts", "core/model-token-limits.js"]), exists("desktop/src/react/settings/helpers.ts")],
    pwa: [contains("desktop/src/react/settings/api.ts", "gsapFetch")],
    cli: [contains("lib/cli/main.ts", "models")],
  },
  {
    id: "cli-runtime-modules",
    title: "CLI runtime modules",
    desktop: [exists("scripts/local-health-check.mjs")],
    pwa: [contains("scripts/surface-feature-audit.mjs", "cli-runtime-modules")],
    cli: [
      exists("lib/cli/main.ts"),
      exists("lib/cli/commands.ts"),
      exists("lib/cli/permission-mode.ts"),
      contains("scripts/gsapctl.mjs", "runCliMain"),
    ],
  },
  {
    id: "local-health-check",
    title: "Local health check",
    desktop: [exists("scripts/local-health-check.mjs")],
    pwa: [contains("package.json", "build:client")],
    cli: [contains("scripts/local-health-check.mjs", "cli:syntax")],
  },
];

const matrixIssues = auditCapabilityMatrix(matrix);
const rows = checks.map((check) => {
  const surfaces = {
    desktop: summarizeSurface(check.desktop),
    pwa: summarizeSurface(check.pwa),
    cli: summarizeSurface(check.cli),
  };
  return {
    id: check.id,
    title: check.title,
    surfaces,
    ok: Object.values(surfaces).every((surface) => surface.ok),
  };
});

const report = {
  ok: rows.every((row) => row.ok) && matrixIssues.length === 0,
  generatedAt: new Date().toISOString(),
  matrix: {
    surfaces: matrix.surfaces,
    platforms: Object.keys(matrix.platforms || {}),
    issues: matrixIssues,
  },
  rows,
};

writeJson(reportPath, report);
writeMarkdown(markdownPath, report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[surface-feature-audit] rows=${rows.length} matrixIssues=${matrixIssues.length}`);
  for (const row of rows.filter((item) => !item.ok)) {
    console.error(`[surface-feature-audit] ${row.id} failed`);
  }
  for (const issue of matrixIssues) console.error(`[surface-feature-audit] ${issue}`);
  if (reportPath) console.log(`[surface-feature-audit] report: ${path.resolve(reportPath)}`);
  if (markdownPath) console.log(`[surface-feature-audit] markdown: ${path.resolve(markdownPath)}`);
}

process.exit(report.ok ? 0 : 1);

function exists(relativePath) {
  const ok = fs.existsSync(path.join(ROOT, relativePath));
  return { ok, label: `${relativePath} exists` };
}

function anyExists(relativePaths) {
  const ok = relativePaths.some((relativePath) => fs.existsSync(path.join(ROOT, relativePath)));
  return { ok, label: `${relativePaths.join(" or ")} exists` };
}

function contains(relativePath, needle) {
  const text = readFile(relativePath);
  const ok = text.includes(needle);
  return { ok, label: `${relativePath} contains ${JSON.stringify(needle)}` };
}

function containsAny(relativePaths, needle) {
  const ok = relativePaths.some((relativePath) => readFile(relativePath).includes(needle));
  return { ok, label: `${relativePaths.join(" or ")} contains ${JSON.stringify(needle)}` };
}

function notContains(relativePath, needle) {
  const text = readFile(relativePath);
  const ok = !text.includes(needle);
  return { ok, label: `${relativePath} does not contain ${JSON.stringify(needle)}` };
}

function matrixHasMediaForAllPlatforms() {
  const missing = KNOWN_PLATFORMS.filter((platform) => !matrix.platforms?.[platform]?.media);
  return {
    ok: missing.length === 0,
    label: missing.length ? `capability matrix missing media: ${missing.join(", ")}` : "capability matrix has media for all known platforms",
  };
}

function summarizeSurface(items) {
  const failed = items.filter((item) => !item.ok).map((item) => item.label);
  return {
    ok: failed.length === 0,
    checks: items.length,
    failed,
  };
}

function auditCapabilityMatrix(value) {
  const issues = [];
  for (const surface of ["desktop", "pwa", "cli"]) {
    if (!value.surfaces?.includes(surface)) issues.push(`missing surface: ${surface}`);
  }
  for (const platform of KNOWN_PLATFORMS) {
    const item = value.platforms?.[platform];
    if (!item) {
      issues.push(`missing platform: ${platform}`);
      continue;
    }
    if (!item.text?.receive || !item.text?.reply) issues.push(`${platform} missing text receive/reply capability`);
    if (!item.media?.inputModes?.length) issues.push(`${platform} missing media input modes`);
    if (!item.media?.supportedKinds?.length) issues.push(`${platform} missing media supported kinds`);
  }
  return issues;
}

function readFile(relativePath) {
  if (fileCache.has(relativePath)) return fileCache.get(relativePath);
  const fullPath = path.join(ROOT, relativePath);
  let text = "";
  try { text = fs.readFileSync(fullPath, "utf-8"); } catch {}
  fileCache.set(relativePath, text);
  return text;
}

function writeJson(target, data) {
  if (!target) return;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeMarkdown(target, data) {
  if (!target) return;
  const lines = [
    "# Surface Feature Audit",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    "| Feature | Desktop | PWA | CLI |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of data.rows) {
    lines.push(`| ${row.title} | ${surfaceLabel(row.surfaces.desktop)} | ${surfaceLabel(row.surfaces.pwa)} | ${surfaceLabel(row.surfaces.cli)} |`);
  }
  lines.push("", "## Capability Matrix", "");
  lines.push(`- Surfaces: ${(data.matrix.surfaces || []).join(", ")}`);
  lines.push(`- Platforms: ${(data.matrix.platforms || []).join(", ")}`);
  if (data.matrix.issues.length) {
    lines.push("", "## Issues", "");
    for (const issue of data.matrix.issues) lines.push(`- ${issue}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function surfaceLabel(surface) {
  if (surface.ok) return `OK (${surface.checks})`;
  return `Missing: ${surface.failed.map(escapeCell).join("; ")}`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}
