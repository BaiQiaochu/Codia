#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "tests");
const TEST_FILE_RE = /\.test\.(?:ts|tsx|js)$/;
const FORMAT = process.argv.includes("--format=triage-md") ? "triage-md" : "json";

const SKIP_DIRS = new Set([
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "dist-server",
  "dist-computer-use",
  "dist-sandbox",
  "desktop/dist-renderer",
  "coverage",
  "artifacts",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function shouldSkip(relativePath) {
  const rel = toPosix(relativePath);
  if (!rel) return false;
  if (/^openhanako-[^/]+(?:\/|$)/.test(rel)) return true;
  return [...SKIP_DIRS].some((part) => rel === part || rel.startsWith(`${part}/`));
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);
    if (shouldSkip(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

function collectMatches(text, re) {
  return [...text.matchAll(re)].map((match) => match[1] ?? match[0]);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function relativeFromRoot(file) {
  return toPosix(path.relative(ROOT, file));
}

function collectIssueRefs(text) {
  const refs = [];
  const issueContextRe = /issue|regression|root[- ]?cause|repro|fix|migration|acceptance|contract|bug/i;
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(/\bissue\s*#?\s*(\d+)/gi)) {
      refs.push(`#${match[1]}`);
    }
    for (const match of line.matchAll(/#(\d+)(?![0-9A-Fa-f])/g)) {
      const ref = `#${match[1]}`;
      const tableCellRef = new RegExp(`\\|\\s*${ref}\\s*\\|`).test(line);
      if (tableCellRef || issueContextRe.test(line)) refs.push(ref);
    }
  }
  return uniq(refs);
}

function analyzeFile(file) {
  const rel = relativeFromRoot(file);
  const text = fs.readFileSync(file, "utf8");
  const haystack = `${rel}\n${text}`;
  const lowerHaystack = haystack.toLowerCase();
  const imports = uniq([
    ...collectMatches(text, /\bfrom\s+["']([^"']+)["']/g),
    ...collectMatches(text, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ]);
  const issueRefs = collectIssueRefs(text);
  const isIssueNamed = /(?:^|\/)(?:acceptance|.*issue[-_]\d+|.*regression).*\.test\.(?:ts|tsx|js)$/i.test(rel);
  const hasAcceptanceLanguage = /acceptance test|issue-specific|temporary acceptance|regression/i.test(text);
  const flags = {
    hasSnapshot: text.includes("toMatchSnapshot") || text.includes("toMatchInlineSnapshot"),
    hasFsTmp: /\bmkdtemp(?:Sync)?\b|\btmpdir\b|\bGSAP_HOME\b|\.gsap(?:-dev)?/.test(haystack),
    hasRoute: /\bHono\b|\bfetch\s*\(|route\b|server\/routes|\bHTTP\b/i.test(haystack),
    hasSecurity: /security|auth|capability|permission|credential|secret|route-security|access|principal|grant|cors|sandbox/i.test(haystack),
    hasBuild: /build|bundle|pack|runtime|native|electron|preload|server|installer|asar|nft/i.test(rel),
    hasBridge: /bridge|telegram|feishu|wechat|qq|media|streaming|adapter/i.test(haystack),
    hasResource: /resource|session[-_ ]?file|mediaitem|sidecar|artifact-tool|managed_cache/i.test(haystack),
    hasProvider: /provider|model payload|reasoning_content|thinking|deepseek|openai|qwen|mimo|zhipu|llm-client/i.test(haystack),
    hasPlatform: /win32|windows|linux|macos|darwin|cross[-_ ]?platform|path separator|shell|seatbelt|bwrap|appcontainer|sandbox/i.test(haystack),
    hasPersistence: /migration|persist|store|registry|sidecar|sqlite|jsonl|yaml|atomic|write|read|cache|GSAP_HOME|mkdtemp/i.test(haystack),
    hasUiState: /desktop\/src\/react|zustand|selector|slice|store|app-events|window\.dispatchEvent|localStorage|sessionStorage/i.test(haystack),
    hasIssueRef: issueRefs.length > 0,
    isIssueNamed,
    isAcceptance: isIssueNamed || hasAcceptanceLanguage,
    touchesPrivateMock: /as any|@ts-ignore|_engine|_agentMgr|_sessionCoord|currentSessionPath|currentAgentId/.test(haystack),
    hardcodesLegacyHome: /\.hanako(?:-dev)?/.test(haystack),
  };
  const category = categorize(rel, lowerHaystack, flags);
  const decision = decide(flags, category);
  return {
    file: rel,
    describeCount: countMatches(text, /\bdescribe\s*\(/g),
    itCount: countMatches(text, /\bit\s*\(/g),
    testCount: countMatches(text, /\btest\s*\(/g),
    issueRefs,
    category,
    decision,
    ownerArea: ownerArea(rel, flags),
    keepReason: keepReason(flags, category),
    deleteOrMergeCandidate: deleteOrMergeCandidate(flags, category, decision),
    flags,
    imports: imports.slice(0, 12),
  };
}

function categorize(rel, lowerHaystack, flags) {
  if (flags.isAcceptance && flags.hasProvider) return "regression / adapter";
  if (flags.isAcceptance && flags.hasBridge) return "regression / adapter";
  if (flags.isAcceptance && flags.hasResource) return "regression / persistence";
  if (flags.isAcceptance) return "regression";
  if (flags.hasSecurity) return "security";
  if (flags.hasBuild) return "build";
  if (flags.hasResource) return "persistence";
  if (flags.hasBridge) return "adapter";
  if (flags.hasProvider) return "adapter";
  if (flags.hasPlatform) return "platform";
  if (/architecture|engine-|manager|coordinator|execution-boundary|non-focus|decoupling|scope|ownership/.test(lowerHaystack)) {
    return "architecture";
  }
  if (flags.hasUiState) return "ui-state";
  if (flags.hasPersistence) return "persistence";
  if (/fixture|scaffold|env-check|setup/.test(rel)) return "scaffold";
  return "implementation";
}

function decide(flags, category) {
  if (category.startsWith("regression")) return "MERGE";
  if (category === "security" || category === "build" || category === "platform") return "KEEP";
  if (category === "persistence" || category === "adapter" || category === "architecture" || category === "ui-state") {
    return flags.touchesPrivateMock || flags.hardcodesLegacyHome ? "SHRINK" : "KEEP";
  }
  if (category === "scaffold") return "QUARANTINE";
  if (flags.touchesPrivateMock || flags.hardcodesLegacyHome) return "SHRINK";
  return "QUARANTINE";
}

function ownerArea(rel, flags) {
  const stem = rel.replace(/^tests\//, "").replace(/\.test\.(?:ts|tsx|js)$/, "");
  if (stem.includes("/")) return stem.split("/")[0];
  if (flags.hasBridge) return "bridge";
  if (flags.hasProvider) return "provider-compat";
  if (flags.hasResource) return "resource/session-file";
  if (flags.hasBuild) return "build/package";
  if (flags.hasSecurity) return "security/access";
  if (flags.hasPlatform) return "platform/sandbox";
  if (flags.hasUiState) return "frontend-state";
  return stem.split("-")[0] || "tests";
}

function keepReason(flags, category) {
  const reasons = [];
  if (flags.hasSecurity) reasons.push("protects security or permission boundary");
  if (flags.hasBuild) reasons.push("protects build, package, or runtime boundary");
  if (flags.hasResource) reasons.push("protects Resource, SessionFile, or media persistence");
  if (flags.hasBridge) reasons.push("protects external adapter or Bridge media contract");
  if (flags.hasProvider) reasons.push("protects provider or model payload contract");
  if (flags.hasPlatform) reasons.push("protects cross-platform path, shell, or sandbox behavior");
  if (flags.hasUiState) reasons.push("protects keyed frontend/session state");
  if (category === "architecture") reasons.push("protects architecture boundary");
  if (category.startsWith("regression")) reasons.push("preserves historical bug signal until absorbed into a contract");
  if (!reasons.length) reasons.push("needs manual review before deletion");
  return reasons.join("; ");
}

function deleteOrMergeCandidate(flags, category, decision) {
  const candidates = [];
  if (category.startsWith("regression")) candidates.push("merge into a permanent behavior-named contract if coverage is unique");
  if (decision === "QUARANTINE") candidates.push("review for implementation detail, duplicate coverage, or obsolete scaffold value");
  if (flags.touchesPrivateMock) candidates.push("rewrite away from private-field/mock coupling if kept");
  if (flags.hardcodesLegacyHome) candidates.push("replace hardcoded legacy data directory with injected temp GSAP_HOME");
  if (!candidates.length) candidates.push("none in first-pass inventory");
  return candidates.join("; ");
}

function markdownEscape(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderTriage(rows) {
  const lines = [
    "# G-SAP Test Triage",
    "",
    "Generated by `node scripts/test-inventory.mjs --format=triage-md`.",
    "",
    "| file | category | keep reason | delete/merge candidate | owner area | decision |",
    "|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push([
      row.file,
      row.category,
      row.keepReason,
      row.deleteOrMergeCandidate,
      row.ownerArea,
      row.decision,
    ].map(markdownEscape).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const rows = walk(TESTS_DIR)
  .sort((a, b) => relativeFromRoot(a).localeCompare(relativeFromRoot(b)))
  .map(analyzeFile);

if (FORMAT === "triage-md") {
  process.stdout.write(renderTriage(rows));
} else {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}
