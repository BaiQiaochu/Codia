// @ts-nocheck
import path from "path";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { createPluginConfigStore } from "./plugin-config.ts";

/**
 * Create a PluginContext for a plugin.
  *
 */
export function createPluginContext({
  pluginId,
  pluginKey,
  source,
  pluginDir,
  dataDir,
  bus,
  accessLevel,
  permissions,
  capabilities,
  sensitiveCapabilities,
  registerSessionFile: registerSessionFileImpl,
  emitResourceChanged,
  emitResourceDeleted,
  emitResourceRenamed,
  resourceIO = null,
  configSchema,
  getWorkspaceDir,
  logSink,
  runtimeContext,
  network,
  fetchImpl,
}) {
  const config = createPluginConfigStore({ dataDir, schema: configSchema });
  const runtimeScope = runtimeContext ? {
    serverId: runtimeContext.serverId,
    serverNodeId: runtimeContext.serverNodeId ?? runtimeContext.serverId,
    userId: runtimeContext.userId,
    studioId: runtimeContext.studioId,
    connectionKind: runtimeContext.connectionKind,
    credentialKind: runtimeContext.credentialKind,
    platformAccountId: runtimeContext.platformAccountId ?? null,
    officialServiceKind: runtimeContext.officialServiceKind ?? null,
    executionBoundary: clonePlain(runtimeContext.executionBoundary),
    sessionId: textOrNull(runtimeContext.sessionId),
    sessionPath: textOrNull(runtimeContext.sessionPath),
    sessionRef: normalizeSessionRef(runtimeContext.sessionRef, runtimeContext),
  } : {};

  const resolvedAccess = accessLevel || "restricted";
  const grantedPermissions = normalizeCapabilityList(permissions);
  const declaredCapabilities = normalizeCapabilityList(capabilities);
  const declaredSensitiveCapabilities = normalizeCapabilityList(sensitiveCapabilities);
  const pluginNetwork = createPluginNetwork({
    pluginId,
    network,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    fetchImpl,
  });
  const pluginResources = createPluginResources({
    pluginId,
    resourceIO,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    runtimeScope,
  });
  const bindOr = (name, fallback) => (
    typeof bus?.[name] === "function" ? bus[name].bind(bus) : fallback
  );
  const prefix = `[plugin:${pluginId}]`;
  const recordLog = (level, args) => {
    if (typeof logSink !== "function") return;
    try {
      logSink({ pluginId, level, args, ts: new Date().toISOString() });
    } catch {
      // Logging must never break plugin execution.
    }
  };
  const log = {
    info: (...args) => { recordLog("info", args); console.log(prefix, ...args); },
    warn: (...args) => { recordLog("warn", args); console.warn(prefix, ...args); },
    error: (...args) => { recordLog("error", args); console.error(prefix, ...args); },
    debug: (...args) => { recordLog("debug", args); console.debug(prefix, ...args); },
  };
  const ownerContext = Object.freeze({
    kind: "plugin",
    pluginId,
    pluginKey: pluginKey || pluginId,
    source: source || "community",
    pluginDir,
    dataDir,
    generatedDir: path.join(dataDir, "generated"),
    config,
    log,
  });
  const pluginBus = resolvedAccess === "full-access"
    ? bus
    : createRestrictedBusProxy(bus, grantedPermissions, bindOr, ownerContext);

  function registerSessionFile(entry = {}) {
    if (typeof registerSessionFileImpl !== "function") {
      throw new Error("plugin session file registry unavailable");
    }
    const sessionId = textOrNull(entry.sessionId) || textOrNull(runtimeScope.sessionId);
    const sessionPath = textOrNull(entry.sessionPath) || textOrNull(runtimeScope.sessionPath);
    const sessionRef = normalizeSessionRef(entry.sessionRef, {
      ...(runtimeScope.sessionRef || {}),
      sessionId,
      sessionPath,
    }) || runtimeScope.sessionRef || null;
    const { filePath, label, origin = "plugin_output" } = entry;
    const storageKind = origin === "plugin_output" ? "plugin_data" : "external";
    if (!sessionId && !sessionPath) throw new Error("plugin registerSessionFile requires sessionId or sessionPath");
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error("plugin registerSessionFile requires an absolute filePath");
    }
    return serializeSessionFile(registerSessionFileImpl({
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      ...(sessionRef ? { sessionRef } : {}),
      filePath,
      label,
      origin,
      storageKind,
    }), { runtimeContext: runtimeScope });
  }

  function toMediaItem(file) {
    return {
      type: "session_file",
      fileId: file.fileId || file.id,
      sessionId: file.sessionId || file.sessionRef?.sessionId || runtimeScope?.sessionId,
      sessionPath: file.sessionPath || file.sessionRef?.sessionPath || runtimeScope?.sessionPath,
      filePath: file.filePath,
      label: file.label || file.displayName || file.filename,
      ...(file.mime ? { mime: file.mime } : {}),
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.kind ? { kind: file.kind } : {}),
    };
  }

  function stageFile(entry = {}) {
    const { origin: _origin, storageKind: _storageKind, ...safeEntry } = entry;
    const file = registerSessionFile({ ...safeEntry, origin: "plugin_output" });
    return { file, sessionFile: file, mediaItem: toMediaItem(file) };
  }

  const appEvents = Object.freeze({
    emit(type, payload = {}) {
      const eventType = textOrNull(type);
      if (!eventType) return false;
      if (!isPlainObject(payload)) return false;
      pluginBus.emit({
        type: "app_event",
        event: {
          type: eventType,
          payload,
          source: `plugin:${pluginId}`,
        },
      }, null);
      return true;
    },
  });

  const resourceEvents = Object.freeze({
    changed(input = {}) {
      if (typeof emitResourceChanged !== "function") return false;
      emitResourceChanged(input);
      return true;
    },
    deleted(input = {}) {
      if (typeof emitResourceDeleted !== "function") return false;
      emitResourceDeleted(input);
      return true;
    },
    renamed(input = {}) {
      if (typeof emitResourceRenamed !== "function") return false;
      emitResourceRenamed(input);
      return true;
    },
  });

  return {
    ...runtimeScope,
    pluginId,
    pluginKey: pluginKey || pluginId,
    source: source || "community",
    pluginDir,
    dataDir,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    bus: pluginBus,
    appEvents,
    resourceEvents,
    resources: pluginResources,
    network: pluginNetwork,
    config,
    log,
    getWorkspaceDir,
    registerSessionFile,
    stageFile,
  };
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeCapabilityList(capabilities) {
  const raw = Array.isArray(capabilities)
    ? capabilities
    : capabilities && typeof capabilities === "object"
      ? Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([key]) => key)
      : [];
  return [...new Set(raw
    .filter((capability) => typeof capability === "string" && capability.trim())
    .map((capability) => capability.trim()))];
}

function hasCapabilityDeclaration(capabilities, capability) {
  if (!Array.isArray(capabilities)) return false;
  if (capabilities.includes("*")) return true;
  if (capabilities.includes(capability)) return true;
  const [namespace] = String(capability || "").split(".");
  return namespace ? capabilities.includes(`${namespace}.*`) : false;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(value, fallback = {}) {
  const sessionId = textOrNull(value?.sessionId) || textOrNull(fallback.sessionId);
  if (!sessionId) return null;
  const sessionPath = textOrNull(value?.sessionPath) || textOrNull(value?.path) || textOrNull(fallback.sessionPath);
  const legacySessionPath = textOrNull(value?.legacySessionPath) || textOrNull(fallback.legacySessionPath);
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function createPluginResources({ pluginId, resourceIO, capabilities, sensitiveCapabilities, runtimeScope }) {
  const getResourceIO = () => {
    const resolved = typeof resourceIO === "function" ? resourceIO() : resourceIO;
    if (resolved && typeof resolved === "object") return resolved;
    throw pluginResourceError(
      "PLUGIN_RESOURCE_IO_UNAVAILABLE",
      "Plugin ResourceIO is unavailable in this runtime",
      { pluginId },
    );
  };
  const assertCapability = (capability) => {
    if (
      hasCapabilityDeclaration(capabilities, capability)
      || hasCapabilityDeclaration(sensitiveCapabilities, capability)
    ) {
      return;
    }
    throw pluginResourceError(
      "PLUGIN_RESOURCE_CAPABILITY_NOT_DECLARED",
      `Plugin ResourceIO operation requires manifest capability "${capability}"`,
      { pluginId, capability },
    );
  };
  const mutationOptions = (operation, options = {}) => ({
    ...(options?.emit === false ? { emit: false } : {}),
    source: "plugin",
    reason: `plugin:${pluginId}:${operation}`,
    sessionId: textOrNull(runtimeScope?.sessionId) || null,
    sessionPath: textOrNull(runtimeScope?.sessionPath) || null,
    principal: {
      kind: "plugin",
      pluginId,
      sessionId: textOrNull(runtimeScope?.sessionId) || null,
      sessionPath: textOrNull(runtimeScope?.sessionPath) || null,
    },
  });

  return Object.freeze({
    async stat(ref) {
      assertCapability("resource.read");
      return getResourceIO().stat(ref);
    },
    async read(ref) {
      assertCapability("resource.read");
      return getResourceIO().read(ref);
    },
    async list(ref) {
      assertCapability("resource.read");
      return getResourceIO().list(ref);
    },
    async search(ref, options = {}) {
      assertCapability("resource.search");
      return getResourceIO().search(ref, options);
    },
    async materialize(ref) {
      assertCapability("resource.materialize");
      return getResourceIO().materialize(ref);
    },
    async write(ref, content, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().write(ref, content, mutationOptions("write", options));
    },
    async writeExpectedVersion(ref, content, expectedVersion, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().writeExpectedVersion(ref, content, expectedVersion, mutationOptions("writeExpectedVersion", options));
    },
    async edit(ref, edits, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().edit(ref, edits, mutationOptions("edit", options));
    },
    async mkdir(ref, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().mkdir(ref, mutationOptions("mkdir", options));
    },
    async delete(ref, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().delete(ref, mutationOptions("delete", options));
    },
    async copy(from, to, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().copy(from, to, mutationOptions("copy", options));
    },
    async rename(from, to, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().rename(from, to, mutationOptions("rename", options));
    },
    async move(from, to, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().move(from, to, mutationOptions("move", options));
    },
    async trash(ref, trashOptions = {}, options = {}) {
      assertCapability("resource.write");
      return getResourceIO().trash(ref, trashOptions, mutationOptions("trash", options));
    },
    resolveWatchTarget(ref) {
      assertCapability("resource.watch");
      const io = getResourceIO();
      if (typeof io.resolveWatchTarget !== "function") {
        throw pluginResourceError(
          "PLUGIN_RESOURCE_WATCH_UNAVAILABLE",
          "Plugin ResourceIO watch target resolution is unavailable in this runtime",
          { pluginId },
        );
      }
      return io.resolveWatchTarget(ref);
    },
  });
}

function pluginResourceError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const USAGE_READ_PERMISSION = "usage.read";
const USAGE_EVENT_TYPE = "llm_usage";
const NETWORK_FETCH_CAPABILITY = "network.fetch";
const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;
const DEFAULT_NETWORK_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function createRestrictedBusProxy(bus, grantedPermissions, bindOr, ownerContext) {
  const hasUsageRead = grantedPermissions.includes(USAGE_READ_PERMISSION);

  const assertUsageAllowed = (permission = USAGE_READ_PERMISSION) => {
    if (permission === USAGE_READ_PERMISSION && !hasUsageRead) {
      throw forbiddenPermissionError(permission);
    }
  };

  const emit = (...args) => {
    const eventType = eventTypeFromEmitArgs(args);
    if (eventType === USAGE_EVENT_TYPE) assertUsageAllowed();
    return bindOr("emit", () => {})(...args);
  };

  const subscribe = (callbackOrType, filterOrHandler, maybeFilter) => {
    const rawSubscribe = bindOr("subscribe", () => () => {});
    if (typeof callbackOrType === "string") {
      const type = callbackOrType;
      if (type === USAGE_EVENT_TYPE) assertUsageAllowed();
      return rawSubscribe(callbackOrType, filterOrHandler, maybeFilter);
    }

    const filter = filterOrHandler && typeof filterOrHandler === "object" ? { ...filterOrHandler } : {};
    const explicitTypes = normalizeEventTypeSet(filter.types);
    if (explicitTypes?.has(USAGE_EVENT_TYPE) && !hasUsageRead) {
      if (explicitTypes.size === 1) assertUsageAllowed();
      explicitTypes.delete(USAGE_EVENT_TYPE);
      filter.types = [...explicitTypes];
    }

    const wrapped = (event, sessionPath) => {
      if (!hasUsageRead && eventTypeFromEvent(event) === USAGE_EVENT_TYPE) return;
      callbackOrType(event, sessionPath);
    };
    return rawSubscribe(wrapped, filter);
  };

  const request = async (type, payload, options) => {
    const capability = typeof bus?.getCapability === "function" ? bus.getCapability(type) : null;
    if (capability?.permission) assertUsageAllowed(capability.permission);
    if (String(type || "").startsWith("usage:")) assertUsageAllowed();
    return bindOr("request", async () => {
      throw new Error("Plugin bus request is unavailable");
    })(type, payload, {
      ...(options || {}),
      caller: ownerContext,
    });
  };

  return Object.freeze({
    emit,
    subscribe,
    request,
    hasHandler: bindOr("hasHandler", () => false),
    listCapabilities: bindOr("listCapabilities", () => []),
    getCapability: bindOr("getCapability", () => null),
  });
}

function eventTypeFromEmitArgs(args) {
  const [event] = args;
  if (typeof event === "string") return event;
  return eventTypeFromEvent(event);
}

function eventTypeFromEvent(event) {
  return event && typeof event === "object" ? event.type : undefined;
}

function normalizeEventTypeSet(types) {
  if (!types) return null;
  if (types instanceof Set) return new Set([...types].filter(Boolean).map(String));
  if (Array.isArray(types)) return new Set(types.filter(Boolean).map(String));
  return null;
}

function forbiddenPermissionError(permission) {
  const err = new Error(`Plugin permission required: ${permission}`);
  err.code = "FORBIDDEN";
  err.permission = permission;
  return err;
}

function createPluginNetwork({ pluginId, network, capabilities, sensitiveCapabilities, fetchImpl }) {
  const cache = new Map();
  const declared = new Set([...(capabilities || []), ...(sensitiveCapabilities || [])]);
  const config = normalizeNetworkConfig(network);
  const effectiveFetch = fetchImpl || globalThis.fetch?.bind(globalThis);

  async function fetchWithPolicy(input, init = {}) {
    if (!declared.has(NETWORK_FETCH_CAPABILITY)) {
      throw pluginNetworkError(
        "PLUGIN_NETWORK_CAPABILITY_NOT_DECLARED",
        `Plugin "${pluginId}" must declare ${NETWORK_FETCH_CAPABILITY} before using ctx.network.fetch().`,
      );
    }
    if (typeof effectiveFetch !== "function") {
      throw pluginNetworkError(
        "PLUGIN_NETWORK_FETCH_UNAVAILABLE",
        `Plugin "${pluginId}" cannot use ctx.network.fetch(): host fetch is unavailable.`,
      );
    }

    const request = normalizeNetworkRequest(input, init);
    validateNetworkRequest(request, config, pluginId);

    const cacheKey = networkCacheKey(request);
    const now = Date.now();
    if (request.cacheTtlMs > 0 && request.method === "GET") {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now) return responseFromNetworkSnapshot(cached);
      if (cached) cache.delete(cacheKey);
    }

    const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;
    const controller = typeof AbortController !== "undefined" && timeoutMs > 0 ? new AbortController() : null;
    let timer = null;
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await effectiveFetch(request.url.toString(), {
        ...request.init,
        method: request.method,
        ...(controller && !request.init.signal ? { signal: controller.signal } : {}),
      });
      const snapshot = await snapshotNetworkResponse(response, request.maxResponseBytes ?? config.maxResponseBytes);
      if (request.cacheTtlMs > 0 && request.method === "GET") {
        cache.set(cacheKey, { ...snapshot, expiresAt: now + request.cacheTtlMs });
      }
      return responseFromNetworkSnapshot(snapshot);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return Object.freeze({ fetch: fetchWithPolicy });
}

function normalizeNetworkConfig(network = {}) {
  const allowedHosts = network.allowedHosts || network.hosts || [];
  const methods = network.methods || ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  return {
    allowedHosts: normalizeAllowedHosts(allowedHosts),
    methods: new Set(methods.map(method => String(method).trim().toUpperCase()).filter(Boolean)),
    allowLocalhost: network.allowLocalhost === true,
    defaultTimeoutMs: positiveNumber(network.defaultTimeoutMs, DEFAULT_NETWORK_TIMEOUT_MS),
    maxResponseBytes: positiveNumber(network.maxResponseBytes, DEFAULT_NETWORK_MAX_RESPONSE_BYTES),
  };
}

function normalizeAllowedHosts(hosts) {
  if (!Array.isArray(hosts)) return new Set();
  return new Set(hosts
    .map(host => String(host || "").trim().toLowerCase())
    .filter(Boolean)
    .map(host => host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "")));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeNetworkRequest(input, init = {}) {
  const requestInput = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const urlText = requestInput ? requestInput.url : String(input);
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw pluginNetworkError("PLUGIN_NETWORK_URL_INVALID", "Invalid network URL.");
  }

  const {
    timeoutMs,
    cacheTtlMs,
    maxResponseBytes,
    ...requestInit
  } = init || {};
  const method = String(requestInit.method || requestInput?.method || "GET").toUpperCase();
  return {
    url,
    method,
    init: requestInit,
    timeoutMs: timeoutMs === undefined ? undefined : positiveNumber(timeoutMs, DEFAULT_NETWORK_TIMEOUT_MS),
    cacheTtlMs: Math.max(0, Number(cacheTtlMs || 0)),
    maxResponseBytes: maxResponseBytes === undefined ? undefined : positiveNumber(maxResponseBytes, DEFAULT_NETWORK_MAX_RESPONSE_BYTES),
  };
}

function validateNetworkRequest(request, config, pluginId) {
  const hostname = request.url.hostname.toLowerCase();
  const isPrivate = isLocalOrPrivateHostname(hostname);
  if (isPrivate && !config.allowLocalhost) {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN",
      `Plugin "${pluginId}" cannot fetch private or localhost network addresses.`,
    );
  }
  if (request.url.protocol !== "https:" && !(config.allowLocalhost && isPrivate && request.url.protocol === "http:")) {
    throw pluginNetworkError("PLUGIN_NETWORK_SCHEME_NOT_ALLOWED", "Plugin network fetch only allows HTTPS URLs unless localhost is explicitly allowed.");
  }
  if (!isHostAllowed(hostname, config.allowedHosts)) {
    throw pluginNetworkError("PLUGIN_NETWORK_HOST_NOT_ALLOWED", `Plugin "${pluginId}" cannot fetch host "${hostname}".`, { host: hostname });
  }
  if (!config.methods.has(request.method)) {
    throw pluginNetworkError("PLUGIN_NETWORK_METHOD_NOT_ALLOWED", `Plugin "${pluginId}" cannot use network method "${request.method}".`);
  }
}

function isHostAllowed(hostname, allowedHosts) {
  if (allowedHosts.has("*")) return true;
  if (allowedHosts.has(hostname)) return true;
  for (const allowed of allowedHosts) {
    if (allowed.startsWith("*.") && hostname.endsWith(allowed.slice(1))) return true;
  }
  return false;
}

function isLocalOrPrivateHostname(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "[::1]") return true;
  if (/^127\./.test(hostname) || /^0\./.test(hostname)) return true;
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1, 3).map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function networkCacheKey(request) {
  return `${request.method} ${request.url.toString()}`;
}

async function snapshotNetworkResponse(response, maxResponseBytes) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxResponseBytes) {
    throw pluginNetworkError("PLUGIN_NETWORK_RESPONSE_TOO_LARGE", "Plugin network response exceeded the configured byte limit.", { maxResponseBytes });
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    bytes,
  };
}

function responseFromNetworkSnapshot(snapshot) {
  return new Response(snapshot.bytes.slice(), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

function pluginNetworkError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, details);
  return err;
}
