#!/usr/bin/env node
import fs from "fs";
import path from "path";

const DEFAULT_ROOTS = ["core", "lib", "server", "desktop/src/react", "shared", "tests", "scripts"];
const TEXT_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const EXCLUDED_SEGMENTS = new Set([
  ".cache",
  ".git",
  "coverage",
  "dist",
  "dist-computer-use",
  "dist-sandbox",
  "dist-server",
  "node_modules",
]);

const APPROVED_IDENTITY_BOUNDARY_RULES = [
  {
    file: /(^|\/)desktop\/src\/react\/stores\/session-slice\.ts$/,
    patterns: [
      /\bsessionIdForPathFromLocatorState\b/,
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\bsessionScopedListIncludes\b/,
      /\bkey\s*!==\s*sessionPath\b/,
      /\blist\.includes\(sessionPath\)/,
      /\blist\.filter\(\(item\) => item !== key && item !== sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/services\/stream-resume\.ts$/,
    patterns: [
      /\bStreamSessionInput\b/,
      /\bresolveStreamSession\b/,
      /\btarget\.key\s*\|\|\s*target\.sessionPath\b/,
      /\bkey\s*!==\s*target\.sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/services\/ws-message-handler\.ts$/,
    patterns: [
      /\baddStreamingSession\(sessionPath,\s*identity\)/,
      /\bremoveStreamingSession\(sessionPath,\s*identity\)/,
    ],
  },
  {
    file: /(^|\/)lib\/session-files\/session-file-registry\.ts$/,
    patterns: [
      /\bsessionFileOwnerKey\b/,
      /\b_sessionKeyForPath\b/,
      /\bnormalizeSessionId\(sessionId\)/,
      /\b_resolveSessionIdForPath\(sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)core\/(engine|session-coordinator)\.ts$/,
    patterns: [
      /\b_sessionRuntimeKeyForPath\b/,
      /\b_getRuntimeValueForPath\b/,
      /\b_setRuntimeValueForPath\b/,
      /\b_deleteRuntimeValueForPath\b/,
      /\bkey\s*!==\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)scripts\/session-path-identity-audit\.mjs$/,
    patterns: [/.*/],
  },
];

function parseArgs(argv) {
  const args = { roots: [], json: false, failOnRisk: false };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--fail-on-risk") args.failOnRisk = true;
    else args.roots.push(arg);
  }
  if (args.roots.length === 0) args.roots = DEFAULT_ROOTS;
  return args;
}

function shouldSkip(fullPath) {
  return fullPath.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function walk(root, files = []) {
  if (!fs.existsSync(root) || shouldSkip(root)) return files;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (TEXT_EXTENSIONS.has(path.extname(root))) files.push(root);
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    walk(path.join(root, entry.name), files);
  }
  return files;
}

function matchesApprovedIdentityBoundary(file, line) {
  const normalizedFile = file.split(path.sep).join("/");
  return APPROVED_IDENTITY_BOUNDARY_RULES.some((rule) => (
    rule.file.test(normalizedFile)
    && rule.patterns.some((pattern) => pattern.test(line))
  ));
}

function classify(file, line) {
  const normalizedFile = file.split(path.sep).join("/");
  const text = line.toLowerCase();
  const storageLike = /\b(map|set|cache|key|hash|summary|memory|pinned|pin|identity|id)\b/i.test(line)
    || text.includes("sessionfilescachedir")
    || text.includes("sessionidfromfilename");

  if (
    normalizedFile.startsWith("tests/")
    || normalizedFile.includes("/tests/")
    || normalizedFile.includes("/__tests__/")
  ) {
    return "test-fixture";
  }
  if (matchesApprovedIdentityBoundary(normalizedFile, line)) return "approved-identity-boundary";
  if (normalizedFile.includes("/session-manifest/") || text.includes("locator") || text.includes("legacy")) {
    return "manifest-or-legacy-boundary";
  }
  if (/\bsession(scoped|ref|runtimekey|idforpath|identitypatch)/i.test(line) || /\bgetsessionidforpath\b/i.test(line)) {
    return "identity-adapter-boundary";
  }
  if (text.includes("currentsessionpath") && !storageLike) return "focus-or-transport-locator";
  if (storageLike || text.includes("currentsessionpath")) return "identity-risk";
  if (/\b(fs|path)\./.test(line) || /\b(readfile|writefile|basename|dirname|sessiondir)\b/i.test(line)) {
    return "filesystem-locator";
  }
  if (normalizedFile.startsWith("server/") || normalizedFile.startsWith("desktop/src/react/")) {
    return "transport-or-ui-locator";
  }
  return "uncategorized";
}

function collectMatches(roots) {
  const matches = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = path.relative(process.cwd(), file);
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.includes("sessionPath") && !line.includes("currentSessionPath")) continue;
        matches.push({
          file: rel,
          line: index + 1,
          category: classify(rel, line),
          text: line.trim(),
        });
      }
    }
  }
  return matches;
}

function summarize(matches) {
  const counts = {};
  for (const match of matches) {
    counts[match.category] = (counts[match.category] || 0) + 1;
  }
  return {
    total: matches.length,
    counts,
    identityRisk: matches.filter((match) => match.category === "identity-risk"),
  };
}

function printText(report, matches) {
  console.log("Session path identity audit");
  console.log("===========================");
  console.log(`Total matches: ${report.total}`);
  for (const [category, count] of Object.entries(report.counts).sort()) {
    console.log(`- ${category}: ${count}`);
  }
  if (report.identityRisk.length > 0) {
    console.log("");
    console.log("Identity-risk samples:");
    for (const match of report.identityRisk.slice(0, 80)) {
      console.log(`${match.file}:${match.line}: ${match.text}`);
    }
  }
  const uncategorized = matches.filter((match) => match.category === "uncategorized");
  if (uncategorized.length > 0) {
    console.log("");
    console.log("Uncategorized samples:");
    for (const match of uncategorized.slice(0, 40)) {
      console.log(`${match.file}:${match.line}: ${match.text}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const matches = collectMatches(args.roots);
const report = summarize(matches);

if (args.json) {
  console.log(JSON.stringify({ ...report, matches }, null, 2));
} else {
  printText(report, matches);
}

if (args.failOnRisk && report.identityRisk.length > 0) {
  process.exitCode = 1;
}
