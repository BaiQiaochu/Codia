// @ts-nocheck
import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { extractZip } from "../../lib/extract-zip.ts";
import { resolveAgent } from "../utils/resolve-agent.ts";
import { fromRoot } from "../../shared/app-root.ts";
import themeRegistry from "../../desktop/src/shared/theme-registry.cjs";
import { routeError, strictJson } from "../hono-helpers.ts";
import { registerSessionFileFromRequest } from "../../lib/session-files/session-file-response.ts";
import {
  createDefaultPluginMarketplace,
  getMarketplacePluginVersionState,
} from "../../lib/plugin-marketplace.ts";
import { comparePluginVersions } from "../../lib/plugin-versioning.ts";
import {
  createPluginInstallBackup,
  restorePluginInstallBackup,
} from "../../lib/plugin-install-backups.ts";
import {
  containsVsCodePackage,
  ensureVsCodeCompatibilityManifest,
  readJsonFile,
  vscodePackageIdentity,
} from "../../shared/vscode-extension-compat.ts";
import { detectIncompatiblePluginFormat } from "../../lib/plugin-format-guard.ts";
import {
  PluginIframeTicketError,
  issuePluginIframeTicket,
  verifyPluginIframeTicket,
} from "../../core/plugin-iframe-ticket-service.ts";
import {
  DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS,
  createPluginAssetSessionCookie,
  issuePluginAssetSession,
} from "../../core/plugin-asset-session-service.ts";
import { servePluginAsset } from "../http/plugin-assets.ts";

const { DEFAULT_THEME } = themeRegistry;

const MAX_PLUGIN_RELEASE_PACKAGE_SIZE = 50 * 1024 * 1024;
const MARKETPLACE_EXTENSION_QUERY_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const MARKETPLACE_TARGET = "Microsoft.VisualStudio.Code";
const MARKETPLACE_FLAGS = 1 | 2 | 4 | 16 | 64 | 128 | 256 | 512;
const PLUGIN_IFRAME_TICKET_QUERY = "pluginIframeTicket";
const PLUGIN_IFRAME_HOST_QUERY_PARAMS = new Set([
  PLUGIN_IFRAME_TICKET_QUERY,
  "agentId",
  "codia-theme",
  "codia-css",
  "codia-theme",
  "codia-css",
  "token",
  "api_key",
]);
const MARKETPLACE_COMPAT_TOKENS = [
  "codia-plugin",
  "codia.plugin",
  ["open", ["h", "anako"].join(""), "-plugin"].join(""),
];
function latestMarketplaceVersion(extension) {
  return Array.isArray(extension?.versions) ? extension.versions[0] || null : null;
}

function marketplaceAssetUrl(version, assetType) {
  const file = Array.isArray(version?.files)
    ? version.files.find((entry) => entry?.assetType === assetType)
    : null;
  if (file?.source) return file.source;
  if (version?.assetUri) return `${version.assetUri}/${assetType}`;
  if (version?.fallbackAssetUri) return `${version.fallbackAssetUri}/${assetType}`;
  return null;
}

function marketplaceProperties(extension, version) {
  const props = [];
  if (Array.isArray(extension?.properties)) props.push(...extension.properties);
  if (Array.isArray(version?.properties)) props.push(...version.properties);
  return props;
}

function marketplaceText(extension, version) {
  const props = marketplaceProperties(extension, version)
    .flatMap((prop) => [prop?.key, prop?.value]);
  return [
    extension?.extensionName,
    extension?.displayName,
    extension?.shortDescription,
    extension?.publisher?.publisherName,
    extension?.publisher?.displayName,
    ...(Array.isArray(extension?.tags) ? extension.tags : []),
    ...(Array.isArray(extension?.categories) ? extension.categories : []),
    ...props,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function marketplaceCompatibility(extension, version) {
  const text = marketplaceText(extension, version);
  const installable = MARKETPLACE_COMPAT_TOKENS.some((token) => text.includes(token));
  if (installable) {
    return {
      kind: "codia-plugin",
      installable: true,
      reason: "Marketplace metadata declares compatible plugin support.",
    };
  }
  return {
    kind: "vscode-extension",
    installable: true,
    runtime: "declarative-compat",
    reason: "VS Code extensions can be installed through the compatibility layer. Declarative contributions appear on a generated compatibility page; activation scripts are not executed.",
  };
}

function marketplaceUrl(extension) {
  const publisher = extension?.publisher?.publisherName;
  const name = extension?.extensionName;
  if (!publisher || !name) return "https://marketplace.visualstudio.com/";
  return `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(`${publisher}.${name}`)}`;
}

function mapMarketplaceExtension(extension) {
  const version = latestMarketplaceVersion(extension);
  const installUrl = marketplaceAssetUrl(version, "Microsoft.VisualStudio.Services.VSIXPackage");
  const compatibility = marketplaceCompatibility(extension, version);
  return {
    id: `${extension?.publisher?.publisherName || "unknown"}.${extension?.extensionName || "unknown"}`,
    publisher: extension?.publisher?.publisherName || "",
    name: extension?.extensionName || "",
    displayName: extension?.displayName || extension?.extensionName || "",
    description: extension?.shortDescription || "",
    version: version?.version || "",
    tags: Array.isArray(extension?.tags) ? extension.tags : [],
    categories: Array.isArray(extension?.categories) ? extension.categories : [],
    marketplaceUrl: marketplaceUrl(extension),
    installUrl,
    compatibility,
  };
}

function createMarketplaceQuery(query, pageSize, pageNumber) {
  const criteria = [{ filterType: 8, value: MARKETPLACE_TARGET }];
  if (query) criteria.push({ filterType: 10, value: query });
  return {
    filters: [{
      criteria,
      pageNumber,
      pageSize,
      sortBy: 0,
      sortOrder: 0,
    }],
    assetTypes: [],
    flags: MARKETPLACE_FLAGS,
  };
}

function isAllowedMarketplaceDownloadUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "marketplace.visualstudio.com"
      || host.endsWith(".visualstudio.com")
      || host.endsWith(".vsassets.io")
      || host.endsWith(".gallerycdn.vsassets.io")
      || host === "vscode.download.prss.microsoft.com";
  } catch {
    return false;
  }
}

function containsPluginManifest(dirPath) {
  const manifestPath = path.join(dirPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.id === "string" && typeof manifest?.name === "string";
  } catch {
    return false;
  }
}

function findPluginSourceDir(rootDir, { requireManifest = false, allowVsCodeExtension = false } = {}) {
  if (containsPluginManifest(rootDir)) return rootDir;
  if (detectIncompatiblePluginFormat(rootDir)) return rootDir;
  if (allowVsCodeExtension && containsVsCodePackage(rootDir)) return rootDir;
  if (!requireManifest && !allowVsCodeExtension) return rootDir;

  const queue = [{ dir: rootDir, depth: 0 }];
  let vscodeCandidate = null;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= 4) continue;
    const entries = fs.readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(current.dir, entry.name);
      if (containsPluginManifest(child)) return child;
      if (detectIncompatiblePluginFormat(child)) return child;
      if (allowVsCodeExtension && !vscodeCandidate && containsVsCodePackage(child)) {
        vscodeCandidate = child;
      }
      queue.push({ dir: child, depth: current.depth + 1 });
    }
  }
  if (vscodeCandidate) return vscodeCandidate;
  return rootDir;
}

function safePathSegment(value, fallback) {
  const text = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

function createPluginRouteError(message: string, status = 400, code = "PLUGIN_ERROR") {
  const err = new Error(message) as Error & { status: number; code: string };
  err.status = status;
  err.code = code;
  return err;
}

export function parsePluginIframeSurfaceRoute(routeUrl) {
  const parsed = new URL(String(routeUrl || ""), "http://codia.local");
  const match = /^\/api\/plugins\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
  if (!match) {
    throw createPluginRouteError("plugin iframe routeUrl must target /api/plugins/:pluginId/*", 400, "PLUGIN_IFRAME_ROUTE_INVALID");
  }
  const pluginId = decodeURIComponent(match[1]);
  const surfacePath = canonicalPluginIframeSurfacePath(match[2] || "/", parsed.searchParams);
  return { pluginId, surfacePath };
}

function canonicalPluginIframeSurfacePath(pathname, searchParams) {
  const params = [];
  for (const [key, value] of searchParams.entries()) {
    if (PLUGIN_IFRAME_HOST_QUERY_PARAMS.has(key)) continue;
    params.push([key, value]);
  }
  params.sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey === rightKey
      ? leftValue.localeCompare(rightValue)
      : leftKey.localeCompare(rightKey)
  ));
  const search = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const safePath = pathname && pathname.startsWith("/") ? pathname : `/${pathname || ""}`;
  return search ? `${safePath}?${search}` : safePath;
}

function pluginIframeSurfaceRouteFromRequest(c) {
  const url = new URL(c.req.url);
  return parsePluginIframeSurfaceRoute(url.pathname + url.search);
}

function verifyPluginIframeTicketForRequest(c, engine, pluginId) {
  const ticket = c.req.query(PLUGIN_IFRAME_TICKET_QUERY);
  if (!ticket) return null;
  const surface = pluginIframeSurfaceRouteFromRequest(c);
  if (surface.pluginId !== pluginId) {
    throw new PluginIframeTicketError("plugin iframe ticket plugin mismatch");
  }
  return verifyPluginIframeTicket({
    codiaHome: engine.codiaHome,
    ticket,
    pluginId,
    surfacePath: surface.surfacePath,
  });
}

function readAuthPrincipal(c) {
  try {
    return c.get("authPrincipal");
  } catch {
    return null;
  }
}

function responseNeedsPluginAssetSession(c, response, iframeTicket) {
  const method = String(c.req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (response.status >= 400) return false;
  if (iframeTicket) return true;
  return String(response.headers.get("content-type") || "").toLowerCase().includes("text/html");
}

function appendPluginAssetSessionCookie(c, engine, pluginId, response, iframeTicket) {
  if (!responseNeedsPluginAssetSession(c, response, iframeTicket)) return response;
  if (!engine?.codiaHome && !engine?.codiaHome) return response;
  const principal = readAuthPrincipal(c);
  const principalId = iframeTicket?.principalId
    || principal?.principalId
    || principal?.userId
    || principal?.deviceId
    || principal?.credentialId;
  if (!principalId) return response;
  const issued = issuePluginAssetSession({
    codiaHome: engine.codiaHome,
    pluginId,
    principalId,
  });
  const maxAgeSeconds = Math.max(
    1,
    Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000)
      || Math.ceil(DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS / 1000),
  );
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", createPluginAssetSessionCookie({
    pluginId,
    token: issued.token,
    maxAgeSeconds,
    secure: new URL(c.req.url).protocol === "https:",
  }));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket = true } = {}) {
  const ticket = c.req.query(PLUGIN_IFRAME_TICKET_QUERY);
  if (!ticket) {
    if (!requireTicket) return null;
    throw new PluginIframeTicketError("plugin iframe ticket required");
  }
  const surface = pluginIframeSurfaceRouteFromRequest(c);
  assertPluginIframeSurfaceAllowed(surface);
  return verifyPluginIframeTicket({
    codiaHome: engine.codiaHome,
    ticket,
    pluginId: surface.pluginId,
    surfacePath: surface.surfacePath,
  });
}

function assertPluginIframeSurfaceAllowed(surface) {
  if (!surface?.pluginId || !surface?.surfacePath) {
    throw new PluginIframeTicketError("plugin iframe route invalid");
  }
  if (PLUGIN_HOST_ROUTE_PLUGIN_IDS.has(surface.pluginId)) {
    throw new PluginIframeTicketError("plugin iframe ticket cannot target plugin host routes", {
      code: "plugin_iframe_ticket_route_forbidden",
    });
  }
  const pathname = new URL(surface.surfacePath, "http://codia.local").pathname;
  if (PLUGIN_HOST_ROUTE_SURFACE_PATHS.has(pathname)) {
    throw new PluginIframeTicketError("plugin iframe ticket cannot target plugin host routes", {
      code: "plugin_iframe_ticket_route_forbidden",
    });
  }
}

const PLUGIN_HOST_ROUTE_PLUGIN_IDS = new Set([
  "config-schemas",
  "event-bus",
  "diagnostics",
  "marketplace",
  "install",
  "settings",
  "pages",
  "widgets",
  "ui-host-capabilities",
  "vscode",
  "settings-tabs",
  "iframe-ticket",
  "theme.css",
]);

const PLUGIN_HOST_ROUTE_SURFACE_PATHS = new Set([
  "/config",
  "/config-schema",
]);

function assertCompatiblePluginFormat(pluginDir) {
  const formatIssue = detectIncompatiblePluginFormat(pluginDir);
  if (!formatIssue) return;
  throw createPluginRouteError(formatIssue.message, 400, formatIssue.code);
}

function assertInsideDir(childPath, parentDir) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  if (child !== parent && !child.startsWith(parentWithSep)) {
    throw createPluginRouteError("Plugin install target escaped plugins directory", 400, "PLUGIN_INSTALL_PATH_INVALID");
  }
}

function readPluginDescriptorForInstall(pm, pluginDir) {
  if (typeof pm.readPluginDescriptor === "function") {
    return pm.readPluginDescriptor(pluginDir, path.basename(pluginDir));
  }
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw createPluginRouteError("Not a valid plugin directory", 400, "PLUGIN_INVALID");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const id = manifest?.id || path.basename(pluginDir);
  return {
    id,
    name: manifest?.name || id,
    version: manifest?.version || "0.0.0",
    manifest,
    pluginDir,
  };
}

function findInstalledPlugin(pm, pluginId, candidateDir) {
  const plugins = typeof pm.listPlugins === "function" ? pm.listPlugins() : [];
  return plugins.find(plugin => (
    plugin.id === pluginId
    || (candidateDir && plugin.pluginDir && path.resolve(plugin.pluginDir) === path.resolve(candidateDir))
  )) || null;
}

function readInstalledVersion(pm, pluginId, targetDir) {
  const existing = findInstalledPlugin(pm, pluginId, targetDir);
  if (existing?.version) return existing.version;
  const manifestPath = path.join(targetDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest?.version || null;
  } catch {
    return null;
  }
}

function getInstallTargetDir(pm, desc, stagedDir, userPluginsDir) {
  const idSegment = safePathSegment(desc.id, path.basename(stagedDir));
  const defaultTarget = path.join(userPluginsDir, idSegment);
  const existing = findInstalledPlugin(pm, desc.id, defaultTarget);
  const targetDir = existing?.pluginDir || defaultTarget;
  assertInsideDir(targetDir, userPluginsDir);
  return targetDir;
}

async function stagePluginSource({
  pm,
  sourcePath,
  userPluginsDir,
  requireManifest = false,
  allowVsCodeExtension = true,
}) {
  const stat = fs.statSync(sourcePath);
  const cleanupPaths = [];
  fs.mkdirSync(userPluginsDir, { recursive: true });
  const tmpTarget = fs.mkdtempSync(path.join(userPluginsDir, ".installing-"));
  cleanupPaths.push(tmpTarget);

  let pluginSrc = null;
  if (sourcePath.endsWith(".zip") || sourcePath.endsWith(".vsix")) {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
    cleanupPaths.push(extractDir);
    await extractZip(sourcePath, extractDir);
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const firstDir = entries.length === 1 && entries[0].isDirectory()
      ? path.join(extractDir, entries[0].name)
      : extractDir;
    pluginSrc = findPluginSourceDir(firstDir, { requireManifest, allowVsCodeExtension });
  } else if (stat.isDirectory()) {
    pluginSrc = findPluginSourceDir(sourcePath, { requireManifest, allowVsCodeExtension });
  } else {
    throw createPluginRouteError("Path must be a .zip/.vsix file or directory", 400, "PLUGIN_INSTALL_SOURCE_INVALID");
  }

  const isVsCodeExtension = allowVsCodeExtension && !containsPluginManifest(pluginSrc) && containsVsCodePackage(pluginSrc);
  fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
  try {
    assertCompatiblePluginFormat(tmpTarget);
  } catch (err) {
    for (const cleanupPath of cleanupPaths) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
    throw err;
  }
  if (isVsCodeExtension) ensureVsCodeCompatibilityManifest(tmpTarget);
  if ((requireManifest && !containsPluginManifest(tmpTarget)) || !pm.isValidPluginDir(tmpTarget)) {
    throw createPluginRouteError(
      requireManifest ? "Not a compatible plugin or VS Code extension directory" : "Not a valid plugin directory",
      400,
      "PLUGIN_INVALID",
    );
  }
  return { stagedDir: tmpTarget, cleanupPaths };
}

function assertExpectedPlugin(desc, { expectedPluginId, expectedVersion }) {
  if (expectedPluginId && desc.id !== expectedPluginId) {
    throw createPluginRouteError(
      `Marketplace package id mismatch: expected "${expectedPluginId}", got "${desc.id}"`,
      409,
      "PLUGIN_PACKAGE_ID_MISMATCH",
    );
  }
  if (expectedVersion && comparePluginVersions(desc.version, expectedVersion) !== 0) {
    throw createPluginRouteError(
      `Marketplace package version mismatch: expected v${expectedVersion}, got v${desc.version}`,
      409,
      "PLUGIN_PACKAGE_VERSION_MISMATCH",
    );
  }
}

function assertInstallEntryHealthy(entry) {
  if (!entry) {
    throw createPluginRouteError("Plugin install failed", 500, "PLUGIN_INSTALL_FAILED");
  }
  if (entry.status === "failed") {
    throw createPluginRouteError(entry.error || "Plugin install failed", 500, "PLUGIN_INSTALL_FAILED");
  }
  if (entry.status === "incompatible") {
    throw createPluginRouteError(entry.error || "Plugin is incompatible with this app version", 409, "PLUGIN_VERSION_INCOMPATIBLE");
  }
}

async function restoreAfterFailedInstall({ engine, pm, backup, targetDir, desc }) {
  if (backup && restorePluginInstallBackup(backup, targetDir)) {
    try {
      await pm.installPlugin(targetDir);
      await engine.syncPluginExtensions?.();
    } catch (restoreErr) {
      console.warn(`[plugin-install] failed to reload restored plugin "${desc.id}":`, restoreErr.message);
    }
    return;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (desc?.id && typeof pm.removePlugin === "function") {
    try {
      await pm.removePlugin(desc.id, { persist: false });
    } catch {
      // The failed install may not have reached the plugin registry.
    }
  }
}

async function installPluginFromPath({
  engine,
  pm,
  sourcePath,
  sessionPath,
  expectedPluginId,
  expectedVersion,
  allowDowngrade = false,
  installRecord = {},
  requireManifest = false,
  allowVsCodeExtension = true,
}: any = {}) {
  fs.statSync(sourcePath);
  const sourceFile = registerSessionFileFromRequest(engine, {
    sessionPath,
    filePath: sourcePath,
    label: path.basename(sourcePath),
    origin: "plugin_install_source",
    storageKind: "install_source",
  });
  const userPluginsDir = pm.getUserPluginsDir();
  const { stagedDir, cleanupPaths } = await stagePluginSource({
    pm,
    sourcePath,
    userPluginsDir,
    requireManifest,
    allowVsCodeExtension,
  });
  let desc = null;
  let targetDir = null;
  let backup = null;

  try {
    desc = readPluginDescriptorForInstall(pm, stagedDir);
    assertExpectedPlugin(desc, { expectedPluginId, expectedVersion });
    targetDir = getInstallTargetDir(pm, desc, stagedDir, userPluginsDir);
    const installedVersion = readInstalledVersion(pm, desc.id, targetDir);
    if (installedVersion && comparePluginVersions(desc.version, installedVersion) < 0 && !allowDowngrade) {
      throw createPluginRouteError(
        `Installing v${desc.version} would downgrade installed v${installedVersion}`,
        409,
        "PLUGIN_VERSION_DOWNGRADE",
      );
    }

    backup = createPluginInstallBackup({
      codiaHome: engine.codiaHome,
      pluginId: desc.id,
      pluginDir: targetDir,
      version: installedVersion,
    });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);

    let entry;
    try {
      entry = await pm.installPlugin(targetDir);
      assertInstallEntryHealthy(entry);
      await engine.syncPluginExtensions?.();
    } catch (err) {
      await restoreAfterFailedInstall({ engine, pm, backup, targetDir, desc });
      throw err;
    }

    engine.recordPluginInstall?.({
      pluginId: entry.id || desc.id,
      installedVersion: entry.version || desc.version,
      source: "local",
      sourcePath,
      ...installRecord,
    });

    return {
      ...entry,
      ...(sourceFile ? { sourceFile } : {}),
    };
  } finally {
    for (const cleanupPath of cleanupPaths) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
  }
}

async function downloadMarketplaceRelease({ engine, plugin }) {
  const dist = plugin?.distribution;
  if (!dist || dist.kind !== "release") {
    const err: any = new Error("Plugin has no release distribution");
    err.status = 400;
    throw err;
  }
  if (!dist.packageUrl || !dist.sha256) {
    const err: any = new Error("Plugin release distribution is missing packageUrl or sha256");
    err.status = 400;
    throw err;
  }

  const expectedSha256 = String(dist.sha256).trim();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    const err: any = new Error("Plugin release sha256 must be 64 lowercase hex characters");
    err.status = 400;
    throw err;
  }

  const packageUrl = new URL(dist.packageUrl);
  if (packageUrl.protocol !== "https:") {
    const err: any = new Error("Plugin release packageUrl must use https");
    err.status = 400;
    throw err;
  }

  const fetchImpl = engine.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    const err: any = new Error("fetch is unavailable");
    err.status = 500;
    throw err;
  }
  if (!engine.codiaHome) {
    const err: any = new Error("The application data directory is unavailable for plugin release installation");
    err.status = 500;
    throw err;
  }

  const res = await fetchImpl(packageUrl.toString());
  if (!res.ok) {
    const err: any = new Error(`Plugin release download failed: ${res.status}`);
    err.status = 502;
    throw err;
  }
  const contentLength = Number(res.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_PLUGIN_RELEASE_PACKAGE_SIZE) {
    const err: any = new Error("Plugin release package is too large");
    err.status = 413;
    throw err;
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_PLUGIN_RELEASE_PACKAGE_SIZE) {
    const err: any = new Error("Plugin release package is too large");
    err.status = 413;
    throw err;
  }
  const actualSha256 = crypto.createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    const err: any = new Error("Plugin release sha256 mismatch");
    err.status = 502;
    throw err;
  }

  const pluginId = safePathSegment(plugin.id, "plugin");
  const version = safePathSegment(plugin.version, "0.0.0");
  const downloadsDir = path.join(engine.codiaHome, "plugin-install-sources", pluginId, version);
  fs.mkdirSync(downloadsDir, { recursive: true });
  const packagePath = path.join(downloadsDir, `${pluginId}-${version}.zip`);
  fs.writeFileSync(packagePath, body);
  return packagePath;
}

function isMarketplacePluginInstallable(plugin, marketplace) {
  if (plugin.distribution?.kind === "source") return !!marketplace.resolveSourceDistribution(plugin);
  if (plugin.distribution?.kind === "release") return !!(plugin.distribution.packageUrl && plugin.distribution.sha256);
  return false;
}

function marketplacePluginForVersion(plugin, versionState) {
  return {
    ...plugin,
    version: versionState.selectedVersion || plugin.version,
    compatibility: versionState.selectedCompatibility || plugin.compatibility || {},
    distribution: versionState.selectedDistribution || null,
  };
}

function getEngineAppVersion(engine) {
  if (typeof engine.getAppVersion === "function") return engine.getAppVersion();
  return engine.appVersion || "0.0.0";
}

function pluginDevServiceOrError(engine: any, c: any) {
  const service = engine.pluginDevService;
  if (!service) {
    return {
      errorResponse: c.json({
        error: "Plugin dev service not available",
        code: "PLUGIN_DEV_SERVICE_UNAVAILABLE",
      }, 500),
    };
  }
  return { service };
}

function pluginDevErrorResponse(c: any, err: any) {
  return c.json({
    error: err?.message || String(err),
    ...(err?.code ? { code: err.code } : {}),
  }, err?.status || 500);
}

function sanitizeMarketplacePluginForClient(plugin) {
  const {
    readme: _readme,
    readmePath: _readmePath,
    distribution,
    versions,
    ...rest
  } = plugin;
  return {
    ...rest,
    distribution: distribution
      ? {
          kind: distribution.kind,
          ...(distribution.path ? { path: distribution.path } : {}),
          ...(distribution.packageUrl ? { packageUrl: distribution.packageUrl } : {}),
          ...(distribution.sha256 ? { sha256: distribution.sha256 } : {}),
        }
      : null,
    versions: Array.isArray(versions)
      ? versions.map(item => ({
          version: item.version,
          compatibility: item.compatibility || {},
          distribution: item.distribution
            ? {
                kind: item.distribution.kind,
                ...(item.distribution.path ? { path: item.distribution.path } : {}),
                ...(item.distribution.packageUrl ? { packageUrl: item.distribution.packageUrl } : {}),
                ...(item.distribution.sha256 ? { sha256: item.distribution.sha256 } : {}),
              }
            : null,
        }))
      : [],
  };
}

/**
  *
 * @param {import("hono").Hono} pluginApp
 * @param {string} pluginId
 * @param {string} [agentId] - 当前 agent id，注入到子请求的 X-CODIA-Agent-Id header
 */
async function proxyToPlugin(c, pluginApp, pluginId, agentId, requestPrincipal = null) {
  const url = new URL(c.req.url);
  const prefix = `/plugins/${pluginId}`;
  const prefixIndex = url.pathname.indexOf(prefix);
  const subPath = prefixIndex !== -1
    ? url.pathname.slice(prefixIndex + prefix.length) || "/"
    : "/";
  url.pathname = subPath;
  url.searchParams.delete(PLUGIN_IFRAME_TICKET_QUERY);

  const headers = new Headers(c.req.raw.headers);
  if (agentId) {
    headers.set("X-CODIA-Agent-Id", agentId);
    headers.set("X-codia-Agent-Id", agentId);
  }

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const subReq = new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  });
  return pluginApp.fetch(subReq, {
    pluginRouteRequest: {
      pluginId,
      agentId: agentId || null,
      principal: requestPrincipal || null,
    },
  });
}

function pluginRouteRequestPrincipal(authPrincipal: any, iframeTicket: any, pluginId: string) {
  if (iframeTicket) {
    return Object.freeze({
      kind: "plugin",
      pluginId,
      principalId: iframeTicket.principalId || null,
      credentialId: iframeTicket.ticketId || null,
      credentialKind: "plugin_iframe_ticket",
      connectionKind: authPrincipal?.connectionKind || null,
    });
  }
  if (!authPrincipal || typeof authPrincipal !== "object") return null;
  return Object.freeze({
    kind: authPrincipal.kind || null,
    pluginId: authPrincipal.pluginId || null,
    principalId: authPrincipal.principalId || authPrincipal.userId || authPrincipal.deviceId || null,
    credentialId: authPrincipal.credentialId || null,
    credentialKind: authPrincipal.credentialKind || null,
    connectionKind: authPrincipal.connectionKind || null,
  });
}

/**
 * Standalone route proxy (for tests).
 * @param {Map<string, import("hono").Hono>} routeRegistry
 */
export function createPluginProxyRoute(routeRegistry: any) {
  const route = new Hono<any>();
  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return proxyToPlugin(c, pluginApp, pluginId, undefined, null);
  });
  return route;
}

/**
 * Plugin management REST API + route proxy (combined).
 * @param {import('../../core/engine.ts').CodiaEngine} engine
 */
export function createPluginsRoute(engine: any) {
  const route = new Hono<any>();

  /**
 * 可见插件过滤 + 序列化（单一出口，所有返回插件列表的端点共用）- * hidden 插件（系统插件）永远不暴露给前端管理页- * @param {object} [opts]
  * */
  function visiblePlugins(pm: any, opts: any = {}) {
    let plugins = pm.listPlugins().filter(p => !p.hidden);
    if (opts.source) plugins = plugins.filter(p => p.source === opts.source);
    return plugins.map(p => ({
      id: p.id, name: p.name, version: p.version,
      description: p.description, status: p.status,
      activationState: p.activationState || null,
      activationEvents: Array.isArray(p.activationEvents) ? p.activationEvents : [],
      activationError: p.activationError || null,
      source: p.source || "community", trust: p.trust || "restricted",
      contributions: p.contributions,
      error: p.error || null,
    }));
  }

  function hasMeaningfulConfigValue(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  }

  function pluginRequiredConfigKeys(plugin) {
    const config = plugin.manifest?.contributes?.configuration || {};
    const keys = new Set(Array.isArray(config.required) ? config.required : []);
    const properties = config.properties || {};
    for (const [key, schema] of Object.entries(properties)) {
      const entry: any = schema;
      if (entry?.required === true || entry?.xRequired === true) keys.add(key);
    }
    return [...keys];
  }

  function pluginCredentialKeys(plugin) {
    const properties = plugin.manifest?.contributes?.configuration?.properties || {};
    return Object.keys(properties).filter((key) => /(api[-_]?key|token|secret|credential)/i.test(key));
  }

  function pluginHealthEntry(plugin) {
    const requiredKeys = pluginRequiredConfigKeys(plugin);
    const missingConfig = requiredKeys.filter((key) => !hasMeaningfulConfigValue(plugin.ctx?.config?.get?.(key)));
    const disabledTools = Array.isArray(plugin.disabledTools) ? plugin.disabledTools : [];
    const credentialKeys = pluginCredentialKeys(plugin);
    const configuredCredentials = credentialKeys.filter((key) => hasMeaningfulConfigValue(plugin.ctx?.config?.get?.(key)));
    const reasons = [];

    if (plugin.status === "failed" && plugin.error) reasons.push(plugin.error);
    if (plugin.status === "disabled") reasons.push("Plugin is disabled in settings.");
    if (plugin.status === "restricted") reasons.push("Full-access plugin is blocked by current trust settings.");
    if (plugin.status === "incompatible" && plugin.error) reasons.push(plugin.error);
    if (missingConfig.length > 0) reasons.push(`Missing required config: ${missingConfig.join(", ")}`);
    if (disabledTools.length > 0) reasons.push(`${disabledTools.length} tool(s) disabled by plugin module.`);

    const health = plugin.status === "failed" || plugin.status === "incompatible"
      ? "error"
      : (plugin.status === "loaded" && missingConfig.length === 0 && disabledTools.length === 0)
        ? "ok"
        : "warn";

    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      source: plugin.source || "community",
      hidden: !!plugin.hidden,
      trust: plugin.trust || "restricted",
      status: plugin.status,
      health,
      reasons,
      missingConfig,
      credentialKeys,
      configuredCredentialKeys: configuredCredentials,
      disabledTools,
      contributions: plugin.contributions || [],
    };
  }

  function pluginHealth(pm: any, opts: any = {}) {
    let plugins = pm.listPlugins();
    if (!opts.includeHidden) plugins = plugins.filter(p => !p.hidden);
    if (opts.source) plugins = plugins.filter(p => p.source === opts.source);
    const items = plugins.map(pluginHealthEntry);
    return {
      summary: {
        total: items.length,
        ok: items.filter(p => p.health === "ok").length,
        warn: items.filter(p => p.health === "warn").length,
        error: items.filter(p => p.health === "error").length,
      },
      plugins: items,
    };
  }

  function pluginCapabilityMatrix(pm) {
    const diagnostics = typeof pm?.getDiagnostics === "function" ? pm.getDiagnostics() : [];
    const diagnosticsById = new Map(diagnostics.map((item) => [item.id, item]));
    return (pm?.listPlugins?.() || [])
      .filter((plugin) => !plugin.hidden)
      .map((plugin) => {
        const diagnostic: any = diagnosticsById.get(plugin.id) || {};
        const routes = diagnostic.routes || {};
        const manifest = plugin.manifest || {};
        const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
        const ui = {
          pages: Array.isArray(routes.pages) ? routes.pages.length : 0,
          widgets: Array.isArray(routes.widgets) ? routes.widgets.length : 0,
          settingsTabs: Array.isArray(routes.settingsTabs) ? routes.settingsTabs.length : 0,
          routeApp: !!routes.hasRouteApp,
        };
        const sizeBytes = safeDirectorySize(plugin.pluginDir);
        return {
          id: plugin.id,
          name: plugin.name || plugin.id,
          version: plugin.version || "",
          status: plugin.status || "unknown",
          enabled: plugin.status !== "disabled",
          source: plugin.source || "community",
          trust: plugin.trust || "restricted",
          tools: normalizeCapabilityNames(diagnostic.tools, "name"),
          commands: normalizeCapabilityNames(diagnostic.commands, "name"),
          providers: normalizeCapabilityNames(diagnostic.providers, "id"),
          ui,
          permissions: [...new Set(permissions.filter(Boolean))],
          contributions: Array.isArray(plugin.contributions) ? plugin.contributions : [],
          configKeys: Object.keys(plugin.configSchema?.properties || {}),
          uiHostCapabilities: Array.isArray(plugin.uiHostCapabilities) ? plugin.uiHostCapabilities : [],
          sizeBytes,
        };
      });
  }

  function summarizeCapabilityMatrix(plugins) {
    return {
      total: plugins.length,
      enabled: plugins.filter((plugin) => plugin.enabled).length,
      disabled: plugins.filter((plugin) => !plugin.enabled).length,
      failed: plugins.filter((plugin) => plugin.status === "failed" || plugin.status === "incompatible").length,
      builtin: plugins.filter((plugin) => plugin.source === "builtin").length,
      community: plugins.filter((plugin) => plugin.source !== "builtin").length,
      totalSizeBytes: plugins.reduce((sum, plugin) => sum + (Number(plugin.sizeBytes) || 0), 0),
    };
  }

  function normalizeCapabilityNames(items, preferredKey) {
    if (!Array.isArray(items)) return [];
    return [...new Set(items.map((item) => {
      if (typeof item === "string") return item;
      return item?.[preferredKey] || item?.name || item?.id || "";
    }).filter(Boolean))];
  }

  function safeDirectorySize(rootDir) {
    if (!rootDir) return 0;
    const resolvedRoot = path.resolve(rootDir);
    let total = 0;
    let seen = 0;
    const walk = (dir) => {
      if (seen > 20000 || total > 2 * 1024 * 1024 * 1024) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const resolved = path.resolve(full);
        if (!resolved.startsWith(resolvedRoot)) continue;
        seen += 1;
        try {
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) total += fs.statSync(full).size;
        } catch {
          // Ignore unreadable plugin resource files.
        }
      }
    };
    walk(resolvedRoot);
    return total;
  }

  function getMarketplace() {
    return engine.pluginMarketplace || createDefaultPluginMarketplace({
      codiaHome: engine.codiaHome,
      fetchImpl: engine.fetch,
    });
  }

  async function installPluginSource(c, sourcePath, sessionPath, { requireManifest = false, allowVsCodeExtension = true, installRecord = {} } = {}) {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    if (!sourcePath) return c.json({ error: "path is required" }, 400);

    const stat = fs.statSync(sourcePath);
    const sourceFile = registerSessionFileFromRequest(engine, {
      sessionPath,
      filePath: sourcePath,
      label: path.basename(sourcePath),
      origin: "plugin_install_source",
      storageKind: "install_source",
    });
    let targetDir;
    const userPluginsDir = pm.getUserPluginsDir();
    fs.mkdirSync(userPluginsDir, { recursive: true });

    if (sourcePath.endsWith(".zip") || sourcePath.endsWith(".vsix")) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
      await extractZip(sourcePath, tmpDir);
      const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
      const firstDir = entries.length === 1 && entries[0].isDirectory()
        ? path.join(tmpDir, entries[0].name)
        : tmpDir;
      const pluginSrc = findPluginSourceDir(firstDir, { requireManifest, allowVsCodeExtension });
      const isVsCodeExtension = allowVsCodeExtension && !containsPluginManifest(pluginSrc) && containsVsCodePackage(pluginSrc);
      const dirName = isVsCodeExtension
        ? `vscode-${vscodePackageIdentity(readJsonFile(path.join(pluginSrc, "package.json"))).id}`
        : path.basename(pluginSrc);
      targetDir = path.join(userPluginsDir, dirName);
      const tmpTarget = targetDir + ".installing";
      if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
      fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
      try {
        assertCompatiblePluginFormat(tmpTarget);
      } catch (err) {
        fs.rmSync(tmpTarget, { recursive: true, force: true });
        throw err;
      }
      if (isVsCodeExtension) ensureVsCodeCompatibilityManifest(tmpTarget);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
      fs.renameSync(tmpTarget, targetDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else if (stat.isDirectory()) {
      const pluginSrc = findPluginSourceDir(sourcePath, { requireManifest, allowVsCodeExtension });
      const isVsCodeExtension = allowVsCodeExtension && !containsPluginManifest(pluginSrc) && containsVsCodePackage(pluginSrc);
      const dirName = isVsCodeExtension
        ? `vscode-${vscodePackageIdentity(readJsonFile(path.join(pluginSrc, "package.json"))).id}`
        : path.basename(pluginSrc);
      targetDir = path.join(userPluginsDir, dirName);
      const tmpTarget = targetDir + ".installing";
      if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
      fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
      try {
        assertCompatiblePluginFormat(tmpTarget);
      } catch (err) {
        fs.rmSync(tmpTarget, { recursive: true, force: true });
        throw err;
      }
      if (isVsCodeExtension) ensureVsCodeCompatibilityManifest(tmpTarget);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
      fs.renameSync(tmpTarget, targetDir);
    } else {
      return c.json({ error: "Path must be a .zip/.vsix file or directory" }, 400);
    }

    if ((requireManifest && !containsPluginManifest(targetDir)) || !pm.isValidPluginDir(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return c.json({ error: requireManifest ? "Not a compatible plugin or VS Code extension directory" : "Not a valid plugin directory" }, 400);
    }

    const entry = await pm.installPlugin(targetDir);
    engine.syncPluginExtensions();
    engine.recordPluginInstall?.({
      pluginId: entry.id,
      installedVersion: entry.version || null,
      source: "local",
      sourcePath,
      ...installRecord,
    });
    return c.json({
      ...entry,
      ...(sourceFile ? { sourceFile } : {}),
    });
  }

  // ── Management API (specific routes first) ──

  route.get("/plugins", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(visiblePlugins(pm, { source: c.req.query("source") }));
  });

  route.get("/plugins/health", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ summary: { total: 0, ok: 0, warn: 0, error: 0 }, plugins: [] });
    return c.json(pluginHealth(pm, {
      source: c.req.query("source"),
      includeHidden: c.req.query("includeHidden") === "1" || c.req.query("includeHidden") === "true",
    }));
  });

  route.get("/plugins/capability-matrix", (c) => {
    const pm = engine.pluginManager;
    const plugins = pm ? pluginCapabilityMatrix(pm) : [];
    return c.json({
      generatedAt: new Date().toISOString(),
      summary: summarizeCapabilityMatrix(plugins),
      plugins,
    });
  });

  route.get("/plugins/config-schemas", (c) => {
    const pm = engine.pluginManager;
    return c.json(pm?.getAllConfigSchemas() || []);
  });

  route.get("/plugins/event-bus/capabilities", (c) => {
    const bus = engine.getEventBus?.() || engine.eventBus || null;
    const capabilities = typeof bus?.listCapabilities === "function"
      ? bus.listCapabilities()
      : [];
    return c.json(capabilities);
  });

  route.get("/plugins/diagnostics", (c) => {
    const pm = engine.pluginManager;
    const bus = engine.getEventBus?.() || engine.eventBus || null;
    return c.json({
      plugins: typeof pm?.getDiagnostics === "function"
        ? pm.getDiagnostics().filter(p => !p.hidden)
        : [],
      eventBus: typeof bus?.listCapabilities === "function" ? bus.listCapabilities() : [],
      tasks: typeof engine.taskRegistry?.listAll === "function" ? engine.taskRegistry.listAll() : [],
      schedules: typeof engine.taskRegistry?.listSchedules === "function" ? engine.taskRegistry.listSchedules() : [],
    });
  });

  route.post("/plugins/dev/install", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    const sourcePath = body.sourcePath || body.path;
    try {
      return c.json(await service.installFromSource({
        sourcePath,
        pluginId: body.pluginId,
        allowFullAccess: !!body.allowFullAccess,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/reload", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.reloadPlugin(c.req.param("id"), {
        devRunId: body.devRunId,
        allowFullAccess: body.allowFullAccess,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.put("/plugins/dev/:id/enabled", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = body.enabled === false
        ? await service.disablePlugin(c.req.param("id"), { devRunId: body.devRunId })
        : await service.enablePlugin(c.req.param("id"), {
            devRunId: body.devRunId,
            allowFullAccess: body.allowFullAccess,
          });
      return c.json(result);
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/reset", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.resetPlugin(c.req.param("id"), {
        devRunId: body.devRunId,
        allowFullAccess: body.allowFullAccess,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.delete("/plugins/dev/:id", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.uninstallPlugin(c.req.param("id"), {
        devRunId: body.devRunId,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.get("/plugins/dev/:id/scenarios", (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const pluginId = c.req.param("id");
    try {
      return c.json({
        pluginId,
        scenarios: service.getScenarios({ pluginId }),
      });
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/scenarios/:scenarioId/run", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.runScenario({
        pluginId: c.req.param("id"),
        scenarioId: c.req.param("scenarioId"),
        allowDestructive: body.allowDestructive === true,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/tools/:toolName/invoke", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.invokeTool({
        pluginId: c.req.param("id"),
        toolName: c.req.param("toolName"),
        input: body.input || {},
        sessionPath: body.sessionPath,
        agentId: body.agentId,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.get("/plugins/dev/diagnostics", (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    return c.json(service.getDiagnostics(c.req.query("pluginId") || undefined));
  });

  route.get("/plugins/dev/surfaces", (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    return c.json(service.listSurfaces(c.req.query("pluginId") || undefined));
  });

  route.post("/plugins/dev/surfaces/describe", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(service.describeSurfaceDebug(body));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.get("/plugins/marketplace", async (c) => {
    const pm = engine.pluginManager;
    const marketplace = getMarketplace();
    const data = await marketplace.load();
    const appVersion = getEngineAppVersion(engine);
    const installed = new Map((pm?.listPlugins?.() || []).map((plugin) => [plugin.id, plugin]));
    return c.json({
      ...data,
      plugins: data.plugins.map((plugin) => {
        const installedPlugin: any = installed.get(plugin.id);
        const installedVersion = installedPlugin?.version || engine.getPluginInstallRecord?.(plugin.id)?.installedVersion || null;
        const versionState = getMarketplacePluginVersionState(plugin, {
          appVersion,
          installedVersion,
        });
        const installCandidate = marketplacePluginForVersion(plugin, versionState);
        return {
          ...sanitizeMarketplacePluginForClient(plugin),
          installed: !!installedPlugin,
          ...versionState,
          canInstall: versionState.canInstall && isMarketplacePluginInstallable(installCandidate, marketplace),
        };
      }),
    });
  });

  route.get("/plugins/marketplace/:id/readme", async (c) => {
    const marketplace = getMarketplace();
    try {
      const readme = await marketplace.getReadme(c.req.param("id"));
      if (readme === null) return c.json({ error: "not found" }, 404);
      return c.json({ pluginId: c.req.param("id"), markdown: readme });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/plugins/marketplace/:id/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const marketplace = getMarketplace();
    const marketplaceData = await marketplace.load();
    const plugin = marketplaceData.plugins.find(item => item.id === c.req.param("id")) || null;
    if (!plugin) return c.json({ error: "not found" }, 404);
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      if (err?.status) return routeError(c, err);
      body = {};
    }
    try {
      const installedPlugin = (pm.listPlugins?.() || []).find(item => item.id === plugin.id);
      const installedVersion = installedPlugin?.version || engine.getPluginInstallRecord?.(plugin.id)?.installedVersion || null;
      const versionState = getMarketplacePluginVersionState(plugin, {
        appVersion: getEngineAppVersion(engine),
        installedVersion,
        targetVersion: body.version,
      });
      if (!versionState.compatible || !versionState.selectedVersion) {
        throw createPluginRouteError("Plugin is incompatible with this app version", 409, "PLUGIN_VERSION_INCOMPATIBLE");
      }
      if (versionState.downgrade && body.allowDowngrade !== true) {
        throw createPluginRouteError(
          `Installing v${versionState.selectedVersion} would downgrade installed v${installedVersion}`,
          409,
          "PLUGIN_VERSION_DOWNGRADE",
        );
      }
      const installCandidate = marketplacePluginForVersion(plugin, versionState);
      const sourcePath = marketplace.resolveSourceDistribution(installCandidate);
      const installPath = sourcePath || await downloadMarketplaceRelease({ engine, plugin: installCandidate });
      const entry = await installPluginFromPath({
        engine,
        pm,
        sourcePath: installPath,
        sessionPath: body.sessionPath,
        expectedPluginId: plugin.id,
        expectedVersion: versionState.selectedVersion,
        allowDowngrade: body.allowDowngrade === true,
        requireManifest: true,
        allowVsCodeExtension: false,
        installRecord: {
          source: "marketplace",
          marketplaceId: plugin.id,
          marketplaceSource: marketplaceData.source?.url || marketplaceData.source?.path || null,
          distributionKind: installCandidate.distribution?.kind || null,
          packageUrl: installCandidate.distribution?.packageUrl || null,
          sha256: installCandidate.distribution?.sha256 || null,
        },
      });
      return c.json(entry);
    } catch (err) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 500);
    }
  });

  route.get("/plugins/marketplace/search", async (c) => {
    const query = String(c.req.query("q") || "").trim();
    const pageSize = Math.min(Math.max(Number(c.req.query("limit")) || 12, 1), 50);
    const pageNumber = Math.max(Number(c.req.query("page")) || 1, 1);
    const fetchImpl = engine.fetch || globalThis.fetch;
    try {
      const res = await fetchImpl(MARKETPLACE_EXTENSION_QUERY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json;api-version=7.2-preview.1",
          "User-Agent": "CODIA Plugin Store",
        },
        body: JSON.stringify(createMarketplaceQuery(query, pageSize, pageNumber)),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return c.json({ error: `Marketplace search failed: ${res.status}` }, 502);
      const payload = await res.json();
      const extensions = payload?.results?.[0]?.extensions || [];
      return c.json({
        source: "vscode-marketplace",
        query,
        items: extensions.map(mapMarketplaceExtension),
      });
    } catch (err) {
      return c.json({ error: err.message || "Marketplace search failed" }, 502);
    }
  });

  route.post("/plugins/marketplace/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }

    const installUrl = String(body.installUrl || "").trim();
    if (!installUrl || !isAllowedMarketplaceDownloadUrl(installUrl)) {
      return c.json({ error: "Marketplace installUrl is not allowed" }, 400);
    }
    const compatibility = body.compatibility || {};
    if (compatibility.installable !== true) {
      return c.json({ error: "Marketplace entry is not installable by this application" }, 400);
    }
    if (!["codia-plugin", "vscode-extension"].includes(compatibility.kind)) {
      return c.json({ error: "Marketplace compatibility kind is not supported" }, 400);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-marketplace-plugin-"));
    const tmpFile = path.join(tmpDir, "plugin.vsix");
    const fetchImpl = engine.fetch || globalThis.fetch;
    try {
      const res = await fetchImpl(installUrl, {
        headers: { "User-Agent": "CODIA Plugin Store" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return c.json({ error: `Marketplace download failed: ${res.status}` }, 502);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpFile, buffer);
      return await installPluginSource(c, tmpFile, body.sessionPath, {
        requireManifest: compatibility.kind === "codia-plugin",
        allowVsCodeExtension: compatibility.kind === "vscode-extension",
        installRecord: {
          source: "coding-marketplace",
          marketplaceSource: "vscode-marketplace",
          compatibilityKind: compatibility.kind,
        },
      });
    } catch (err) {
      return c.json({ error: err.message || "Marketplace install failed" }, 500);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  route.get("/plugins/:id/config-schema", (c) => {
    const pm = engine.pluginManager;
    const schema = pm?.getConfigSchema(c.req.param("id"));
    if (!schema) return c.json({ error: "not found" }, 404);
    return c.json(schema);
  });

  route.get("/plugins/:id/config", (c) => {
    const pm = engine.pluginManager;
    const config = pm?.getConfig?.(c.req.param("id"), {
      scope: c.req.query("scope") || "global",
      agentId: c.req.query("agentId") || undefined,
      sessionPath: c.req.query("sessionPath") || undefined,
    });
    if (!config) return c.json({ error: "not found" }, 404);
    return c.json(config);
  });

  route.put("/plugins/:id/config", async (c) => {
    const pm = engine.pluginManager;
    if (!pm?.setConfig) return c.json({ error: "Plugin manager not available" }, 500);
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    try {
      const config = pm.setConfig(c.req.param("id"), body.values || {}, {
        scope: body.scope || "global",
        agentId: body.agentId,
        sessionPath: body.sessionPath,
      });
      const { rawValues: _rawValues, ...safeConfig } = config;
      return c.json(safeConfig);
    } catch (err) {
      if (err?.code === "PLUGIN_CONFIG_INVALID") {
        return c.json({ error: err.message, code: err.code, fields: err.errors || [] }, 400);
      }
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin install ──
  route.post("/plugins/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    const { path: sourcePath, sessionPath, allowDowngrade = false } = body;
    if (!sourcePath) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await installPluginFromPath({
        engine,
        pm,
        sourcePath,
        sessionPath,
        allowDowngrade,
      }));
    } catch (err) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 500);
    }
  });

  // ── Plugin delete ──
  route.delete("/plugins/:id", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    try {
      const pluginDir = await pm.removePlugin(id);
      engine.syncPluginExtensions();
      if (pluginDir && fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin enable/disable ──
  route.put("/plugins/:id/enabled", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    const { enabled } = body;
    try {
      if (enabled) {
        await pm.enablePlugin(id);
      } else {
        await pm.disablePlugin(id);
      }
      engine.syncPluginExtensions();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Global plugin settings ──
  route.get("/plugins/settings", (c) => {
    const pm = engine.pluginManager;
    return c.json({
      allow_full_access: pm?.getAllowFullAccess() || false,
      plugin_dev_tools_enabled: typeof engine.getPluginDevToolsEnabled === "function"
        ? engine.getPluginDevToolsEnabled()
        : false,
      plugins_dir: pm?.getUserPluginsDir() || "",
    });
  });

  route.put("/plugins/settings", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }
    const { allow_full_access, plugin_dev_tools_enabled } = body;
    if (typeof allow_full_access === "boolean") {
      await pm.setFullAccess(allow_full_access);
      engine.syncPluginExtensions();
    }
    if (typeof plugin_dev_tools_enabled === "boolean" && typeof engine.setPluginDevToolsEnabled === "function") {
      engine.setPluginDevToolsEnabled(plugin_dev_tools_enabled);
    }
    return c.json(visiblePlugins(pm, { source: "community" }));
  });

  // ── Plugin UI panel endpoints ──

  route.get("/plugins/pages", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const pages = pm.getPages().map(p => ({
      pluginId: p.pluginId,
      title: p.title,
      icon: p.icon,
      routeUrl: `/api/plugins/${p.pluginId}${p.route}`,
      hostCapabilities: Array.isArray(p.hostCapabilities) ? p.hostCapabilities : [],
    }));
    return c.json(pages);
  });

  route.get("/plugins/widgets", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const widgets = pm.getWidgets().map(w => ({
      pluginId: w.pluginId,
      title: w.title,
      icon: w.icon,
      routeUrl: `/api/plugins/${w.pluginId}${w.route}`,
      hostCapabilities: Array.isArray(w.hostCapabilities) ? w.hostCapabilities : [],
    }));
    return c.json(widgets);
  });

  route.get("/plugins/ui-host-capabilities", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(pm.getUiHostCapabilityGrants?.() || []);
  });

  route.get("/plugins/vscode/file-icon-themes", (c) => {
    const pm = engine.pluginManager;
    if (!pm?.getVsCodeFileIconThemes) return c.json([]);
    return c.json(pm.getVsCodeFileIconThemes());
  });

  route.get("/plugins/settings-tabs", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const tabs = pm.getSettingsTabs?.().map(t => ({
      pluginId: t.pluginId,
      id: t.id,
      title: t.title,
      icon: t.icon,
      nativeComponent: t.nativeComponent,
    })) || [];
    return c.json(tabs);
  });

  route.post("/plugins/iframe-ticket", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    try {
      const body = await strictJson(c);
      const { pluginId, surfacePath } = parsePluginIframeSurfaceRoute(body?.routeUrl);
      assertPluginIframeSurfaceAllowed({ pluginId, surfacePath });
      if (!pm.getRouteApp(pluginId)) {
        return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
      }
      const principal = c.get("authPrincipal");
      const principalId = principal?.principalId
        || principal?.userId
        || principal?.deviceId
        || principal?.credentialId
        || "principal_unknown";
      const issued = issuePluginIframeTicket({
        codiaHome: engine.codiaHome,
        pluginId,
        surfacePath,
        principalId,
      });
      return c.json({
        ticket: issued.ticket,
        ticketId: issued.ticketId,
        pluginId,
        surfacePath,
        expiresAt: issued.expiresAt,
      });
    } catch (err) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 400);
    }
  });

  route.get("/plugins/theme.css", (c) => {
    const theme = c.req.query("theme") || DEFAULT_THEME;
    // Sanitize theme name to prevent path traversal
    const safeName = path.basename(theme).replace(/[^a-zA-Z0-9_-]/g, "");
    const candidates = [
      fromRoot("desktop", "src", "themes", `${safeName}.css`),
      fromRoot("desktop", "dist-renderer", "themes", `${safeName}.css`),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      c.header("Content-Type", "text/css");
      return c.body("/* theme not found */");
    }
    let css = fs.readFileSync(found, "utf-8");
    // Flatten selectors for iframe consumption:
 //
    css = css.replace(/\[data-theme="[^"]*"\](?:,\s*:root:not\(\[data-theme\]\))?/g, ":root");
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(css);
  });

  route.get("/plugins/:pluginId/assets/*", (c) => servePluginAsset(c, engine, false));
  route.on("HEAD", "/plugins/:pluginId/assets/*", (c) => servePluginAsset(c, engine, true));

  // ── Plugin route proxy (catch-all last) ──

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = engine.pluginManager?.getRouteApp(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    let iframeTicket = null;
    try {
      iframeTicket = verifyPluginIframeTicketForRequest(c, engine, pluginId);
    } catch (err) {
      if (err instanceof PluginIframeTicketError) {
        return c.json({ error: err.code, detail: err.message }, err.status);
      }
      throw err;
    }
    const url = new URL(c.req.url);
    const prefix = `/plugins/${pluginId}`;
    const prefixIndex = url.pathname.indexOf(prefix);
    const subPath = prefixIndex !== -1
      ? url.pathname.slice(prefixIndex + prefix.length) || "/"
      : "/";
    await engine.pluginManager?.activatePluginRoute?.(pluginId, subPath);
    const agent = resolveAgent(engine, c);
    const agentId = agent?.id || null;
    const requestPrincipal = pluginRouteRequestPrincipal(readAuthPrincipal(c), iframeTicket, pluginId);
    const response = await proxyToPlugin(c, pluginApp, pluginId, agentId, requestPrincipal);
    return appendPluginAssetSessionCookie(c, engine, pluginId, response, iframeTicket);
  });

  return route;
}
