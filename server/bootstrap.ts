import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // Ignore logging failures during early startup.
  }
}

function logError(line) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Ignore logging failures during early startup.
  }
}

function assertSupportedServerEntry(entry) {
  if (/\.tsx?$/i.test(entry) && !process.features?.typescript) {
    throw new Error("[server-bootstrap] TypeScript source entry requires Node 24 or a prebuilt JavaScript bundle");
  }
}

const codiaRoot = process.env.CODIA_ROOT || __dirname;
const serverEntry =
  process.env.CODIA_SERVER_ENTRY ||
  path.join(codiaRoot, "bundle", "index.js");

log(`[server-bootstrap] process started pid=${process.pid} platform=${process.platform} arch=${process.arch}`);
log(`[server-bootstrap] node=${process.version} codiaHome=${process.env.CODIA_HOME || "unset"}`);
log(`[server-bootstrap] root=${codiaRoot}`);
log(`[server-bootstrap] entry=${serverEntry}`);

try {
  assertSupportedServerEntry(serverEntry);
  log("[server-bootstrap] importing server entry");
  const pendingLog = setTimeout(() => {
    log("[server-bootstrap] server entry import still pending");
  }, 5000);
  pendingLog.unref?.();
  try {
    await import(pathToFileURL(serverEntry).href);
    log("[server-bootstrap] server entry import completed");
  } finally {
    clearTimeout(pendingLog);
  }
} catch (err) {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  logError(`[server-bootstrap] failed to import server entry: ${message}`);
  process.exitCode = 1;
  throw err;
}
