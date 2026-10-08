// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { planArtifactCleanup } from "../scripts/clean-artifacts.mjs";

const CANONICAL_AUDITS = Object.freeze({
  themeToken: "theme-token-audit.json",
  mojibake: "mojibake-audit.json",
  commentCode: "comment-code-audit.json",
});

export function createStartupHealthSnapshot({
  projectRoot = process.cwd(),
  artifactsDir = path.join(projectRoot, "artifacts"),
  bridgeManager = null,
  resourcesPath = process.resourcesPath || "",
  platform = process.platform,
} = {}) {
  return {
    generatedAt: new Date().toISOString(),
    buildArtifacts: summarizeBuildArtifacts(artifactsDir),
    audits: Object.fromEntries(
      Object.entries(CANONICAL_AUDITS).map(([key, filename]) => [
        key,
        summarizeAudit(path.join(artifactsDir, filename)),
      ]),
    ),
    bridge: summarizeBridge(bridgeManager),
  };
}

function summarizeBuildArtifacts(artifactsDir) {
  try {
    const plan = planArtifactCleanup({ artifactsDir });
    return {
      available: true,
      status: plan.remove.length > 0 ? "warn" : "ok",
      keep: plan.keep.length,
      removable: plan.remove.length,
      samples: plan.remove.slice(0, 8).map((item) => ({
        path: slash(path.relative(process.cwd(), item.path)),
        type: item.type,
        reason: item.reason,
      })),
    };
  } catch (err) {
    return {
      available: false,
      status: "warn",
      keep: 0,
      removable: 0,
      error: err?.message || String(err),
      samples: [],
    };
  }
}

function summarizeAudit(filePath) {
  const report = readJson(filePath);
  if (!report) {
    return {
      available: false,
      status: "warn",
      ok: null,
      blockers: 0,
      warnings: 0,
      generatedAt: null,
    };
  }
  const blockers = Number(report.counts?.blockers ?? report.blockers?.length ?? 0) || 0;
  const warnings = Number(report.counts?.warnings ?? report.warnings?.length ?? 0) || 0;
  return {
    available: true,
    status: blockers > 0 ? "error" : warnings > 0 ? "warn" : "ok",
    ok: report.ok === true,
    blockers,
    warnings,
    generatedAt: report.generatedAt || report.scannedAt || null,
  };
}

function summarizeBridge(bridgeManager) {
  const live = typeof bridgeManager?.getStatus === "function" ? bridgeManager.getStatus() : {};
  const reliability = typeof bridgeManager?.getReliabilitySummary === "function"
    ? bridgeManager.getReliabilitySummary()
    : null;
  const platforms = Object.values(live || {});
  return {
    available: !!bridgeManager,
    total: platforms.length,
    connected: platforms.filter((item) => item?.status === "connected").length,
    connecting: platforms.filter((item) => item?.status === "connecting").length,
    errors: platforms.filter((item) => item?.status === "error" || item?.error).length,
    deadLetters: reliability?.deadLetters ?? 0,
    pendingDeadLetters: reliability?.pendingDeadLetters ?? 0,
    messageLedger: reliability?.messages ?? 0,
    platforms: platforms.slice(0, 20).map((item) => ({
      platform: item.platform || null,
      agentId: item.agentId || null,
      status: item.status || "unknown",
      retryCount: item.retryCount ?? 0,
      lastSyncAt: item.lastSyncAt ?? null,
    })),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}
