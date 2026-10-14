/**
 * postinstall Pi SDK verifier.
 *
 * Older builds patched node_modules/@earendil-works/pi-coding-agent in place.
 * Pi SDK 0.68+ supports tool-name allowlists, and this project converts local
 * Tool[] objects through lib/pi-sdk before createAgentSession is called.
 *
 * Keep this filename so package.json's postinstall hook stays stable. The script
 * now only verifies the SDK version, required exports, and import boundaries.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sdkRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piAiRoot = path.join(root, "node_modules", "@earendil-works", "pi-ai");
const verifiedVersions = new Set(["1.1.0"]);
const verifiedPiAiVersions = new Set(["1.1.0"]);
const piAgentCoreRoot = path.join(root, "node_modules", "@earendil-works", "pi-agent-core");
const piCodemodeRoot = path.join(root, "node_modules", "@earendil-works", "pi-codemode");

function fail(message) {
  console.error(`[verify-pi-sdk] ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

if (!fs.existsSync(sdkRoot)) {
  console.log("[verify-pi-sdk] SDK not installed, skipping");
  process.exit(0);
}

const pkg = readJson(path.join(sdkRoot, "package.json"));
if (!verifiedVersions.has(pkg.version)) {
  fail(`SDK version ${pkg.version} is not verified. Verified versions: ${[...verifiedVersions].join(", ")}`);
}

if (!fs.existsSync(piAiRoot)) {
  fail("@earendil-works/pi-ai is not installed");
}

const piAiPkg = readJson(path.join(piAiRoot, "package.json"));
if (!verifiedPiAiVersions.has(piAiPkg.version)) {
  fail(`pi-ai version ${piAiPkg.version} is not verified. Verified versions: ${[...verifiedPiAiVersions].join(", ")}`);
}
const piAgentCorePkg = readJson(path.join(piAgentCoreRoot, "package.json"));
if (piAgentCorePkg.version !== "1.1.0") {
  fail(`pi-agent-core version ${piAgentCorePkg.version} does not match 1.1.0`);
}
if (!fs.existsSync(piCodemodeRoot)) {
  fail("@earendil-works/pi-codemode is not installed");
}
const piCodemodePkg = readJson(path.join(piCodemodeRoot, "package.json"));
if (piCodemodePkg.version !== pkg.version) {
  fail(`pi-codemode version ${piCodemodePkg.version} does not match pi-coding-agent ${pkg.version}`);
}
const piCodemodeDeclarations = fs.readFileSync(
  path.join(piCodemodeRoot, "dist", "declarations.js"),
  "utf8",
);
if (!piCodemodeDeclarations.includes("MCP_TYPESCRIPT_PREAMBLE")) {
  fail("pi-codemode declarations are incompatible with the verified coding-agent runtime");
}

const sdkIndex = fs.readFileSync(path.join(sdkRoot, "dist", "index.js"), "utf8");
const expectedExportMarkers = [
  "createAgentSession",
  "createCodemodeExtension",
  "createToolSearchExtension",
  "ModelRuntime",
  "ModelRegistry",
  "createReadTool",
  "createWriteTool",
  "createEditTool",
  "createBashTool",
  "createGrepTool",
  "createFindTool",
  "createLsTool",
  "parseSessionEntries",
  "buildSessionContext",
];

for (const marker of expectedExportMarkers) {
  if (!sdkIndex.includes(marker)) {
    fail(`expected SDK export marker not found: ${marker}`);
  }
}

const scanDirs = ["core", "server", "lib", "hub"].map((d) => path.join(root, d));
const adapterDir = path.join(root, "lib", "pi-sdk");
const importPattern = /(?:from\s+["']@earendil-works\/|import\s*\(\s*["']@earendil-works\/|require\s*\(\s*["']@earendil-works\/)/;
const leaks = [];

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === adapterDir || entry.name === "node_modules") continue;
      scanDir(full);
    } else if (/\.(js|mjs|cjs|ts|tsx)$/.test(entry.name)) {
      const content = fs.readFileSync(full, "utf8");
      if (importPattern.test(content)) {
        leaks.push(path.relative(root, full));
      }
    }
  }
}

for (const dir of scanDirs) scanDir(dir);

if (leaks.length > 0) {
  fail(`production files bypass lib/pi-sdk: ${leaks.join(", ")}`);
}

console.log("[verify-pi-sdk] all checks passed");
