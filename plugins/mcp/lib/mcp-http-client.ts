// @ts-nocheck
import { MCP_PROTOCOL_VERSION } from "./mcp-stdio-client.ts";
import { getOutboundProxyConfig } from "../../../lib/net/outbound-proxy.ts";
import {
  normalizeNetworkProxyConfig,
  proxyConfigFromEnvironment,
  resolveProxyForUrl,
} from "../../../shared/network-proxy.ts";
import {
  MCP_PROTOCOL_VERSION_HEADER,
  headersWithoutMcpProtocolVersion,
  resolveInitialMcpProtocolVersion,
} from "./mcp-protocol-version.ts";

const STREAMABLE_ACCEPT = "application/json, text/event-stream";
const SSE_ACCEPT = "text/event-stream";
const FALLBACK_STATUSES = new Set([400, 404, 405]);

export class McpHttpError extends Error {
  constructor(message, { status = null, body = "", headers = null, oauthError = "" } = {}) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
    this.body = body;
    this.headers = headers;
    // OAuth 2.0 error code (RFC 6749 §5.2) when this failure came from a token
    // endpoint, e.g. "invalid_grant" (the refresh token is dead). Empty for
    // transport-level failures (a 5xx / 404 with no OAuth error body). Used by
    // the auth-terminal classifier so a dead refresh token routes to needs-auth
    // even though its HTTP status is 400, not 401/403.
    this.oauthError = oauthError;
  }
}

// An auth-terminal failure means re-authorization is required and retrying with
// the same credentials is futile (-needs-auth, never backoff/loop). Two
// independent signals qualify: an HTTP 401/403 on a resource request, or an
// OAuth token-endpoint error that invalidates the grant/client. invalid_grant =
// the refresh token expired/was revoked; invalid_client / unauthorized_client =
// the registered client is no longer accepted. Transient failures (network drop,
// 5xx, request-shape OAuth errors) are deliberately excluded so they keep
// reconnecting. Single source of truth shared by the runtime and the client.
const AUTH_TERMINAL_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

export function isAuthTerminalError(err) {
  // McpHttpError carries status/oauthError directly; a non-McpHttpError transport
 // error may still surface a status field -read both uniformly via optional chain.
  if (err?.status === 401 || err?.status === 403) return true;
  return typeof err?.oauthError === "string" && AUTH_TERMINAL_OAUTH_ERRORS.has(err.oauthError);
}

export function parseSseEvents(text) {
  const events = [];
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  for (const block of normalized.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const event = { event: "message", data: "", id: "" };
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event.event = value || "message";
      else if (field === "id") event.id = value;
      else if (field === "data") dataLines.push(value);
    }
    event.data = dataLines.join("\n");
    events.push(event);
  }
  return events;
}

function configuredAuthToken(server) {
  const authType = stringOrEmpty(server?.authType);
  if (authType === "oauth") return stringOrEmpty(server?.oauth?.accessToken);
  if (authType === "bearer") return stringOrEmpty(server?.authorizationToken);
  if (authType === "none") return "";
  return stringOrEmpty(server?.oauth?.accessToken) || stringOrEmpty(server?.authorizationToken);
}

async function requestAuthToken(server, getAuthToken) {
  const dynamicToken = getAuthToken ? stringOrEmpty(await getAuthToken()) : "";
  return dynamicToken || configuredAuthToken(server);
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function connectorHeaders(server) {
  if (!server?.headers || typeof server.headers !== "object" || Array.isArray(server.headers)) return {};
  return Object.fromEntries(
    Object.entries(server.headers).filter(([key, value]) => typeof key === "string" && typeof value === "string"),
  );
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || response?.headers?.get?.(name.toLowerCase()) || "";
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isJsonRpcResponse(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || message.id == null) return false;
  if (Object.prototype.hasOwnProperty.call(message, "method")) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  return hasResult !== hasError;
}

function methodErrorMessage(status, body) {
  if (status === 401) return "MCP connector authentication failed or token expired";
  if (status === 403) return "MCP connector authorization failed or scopes are insufficient";
  if (status === 404) return "MCP connector session expired or endpoint was not found";
  return `MCP connector HTTP request failed with status ${status}${body ? `: ${body}` : ""}`;
}

function resolveEndpoint(endpoint, baseUrl) {
  return new URL(endpoint, baseUrl).href;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  if (!timeoutMs) return fetchImpl(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const originalSignal = init?.signal;
  const abortFromOriginal = () => controller.abort();
  originalSignal?.addEventListener?.("abort", abortFromOriginal, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    originalSignal?.removeEventListener?.("abort", abortFromOriginal);
  }
}

function requestTimeoutMs(server) {
  const timeout = Number(server?.timeout || 0);
  return Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 30_000;
}

export function resolveMcpHttpProxyDiagnostics(server, { proxyConfig = getOutboundProxyConfig(), env = process.env } = {}) {
  const transport = stringOrEmpty(server?.transport);
  const url = stringOrEmpty(server?.url);
  const applicable = !!url && transport !== "stdio";
  if (!applicable) {
    return {
      applicable: false,
      proxyUrl: "",
      source: "not-applicable",
      connectorEnvProxyIgnored: hasConnectorProxyEnv(server),
    };
  }

  const normalized = normalizeNetworkProxyConfig(proxyConfig);
  const effective = normalized.mode === "system" ? proxyConfigFromEnvironment(env) : normalized;
  const proxyUrl = resolveProxyForUrl(url, normalized, env);
  let source = normalized.mode;
  if (normalized.mode === "manual") source = proxyUrl ? "app" : "bypass";
  if (normalized.mode === "system") source = effective.mode === "direct" ? "system" : "system-env";
  if (normalized.mode === "direct") source = "direct";

  return {
    applicable: true,
    proxyUrl: redactProxyUrl(proxyUrl),
    source,
    connectorEnvProxyIgnored: hasConnectorProxyEnv(server),
  };
}

function hasConnectorProxyEnv(server) {
  const env = server?.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env : {};
  return ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
    .some((key) => typeof env[key] === "string" && env[key].trim());
}

function redactProxyUrl(proxyUrl) {
  if (!proxyUrl) return "";
  try {
    const url = new URL(proxyUrl);
    if (url.username) url.username = "********";
    if (url.password) url.password = "********";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export class McpStreamableHttpClient {
  constructor(server, { fetchImpl = globalThis.fetch, log = console, onClose = null, getAuthToken = null, refreshAuthToken = null } = {}) {
    this.server = server;
    this.fetchImpl = fetchImpl;
    this.log = log;
    // onClose({ reason, expected, needsAuth }) reports an unexpected death of a
    // previously-live session so McpRuntime can decide whether to reconnect.
    // The inline 404 session refresh recovers in place and never reports here.
    this.onClose = typeof onClose === "function" ? onClose : null;
    // OAuth self-heal seams (#1286 ③a, 方案 A). The live client snapshots the
    // connector, so config refreshes never reach this.server. getAuthToken()
    // returns the freshest access token per request (runtime pre-refreshes near
    // expiry + dedups); refreshAuthToken() force-refreshes on a 401. Both are
    // optional: when absent, the client falls back to the snapshot token and a
    // 401 is not retried (pure-client unit tests keep the old behavior).
    this.getAuthToken = typeof getAuthToken === "function" ? getAuthToken : null;
    this.refreshAuthToken = typeof refreshAuthToken === "function" ? refreshAuthToken : null;
    this.endpoint = server?.url || "";
    this._nextId = 1;
    this._closed = true;
    this._initialized = false;
    this._stopping = false;
    this.sessionId = "";
    this.initialProtocolVersion = resolveInitialMcpProtocolVersion({ headers: connectorHeaders(server) });
    this.protocolVersion = this.initialProtocolVersion;
  }

  get running() {
    return !this._closed && this._initialized;
  }

  async start() {
    if (this.running) return;
    if (!this.endpoint) throw new Error("MCP connector URL is required");
    this._closed = false;
    this._stopping = false;
    try {
      await this.initialize();
      this._initialized = true;
    } catch (err) {
      this._closed = true;
      this._initialized = false;
      throw err;
    }
  }

  async initialize() {
    this.protocolVersion = this.initialProtocolVersion;
    const result = await this._request("initialize", {
      protocolVersion: this.initialProtocolVersion,
      capabilities: {},
      clientInfo: {
        name: "gsap",
        title: "G-SAP",
        version: "0.6.7",
      },
    }, { initializing: true, retryOnSessionExpired: false });
    if (typeof result?.protocolVersion === "string") {
      this.protocolVersion = result.protocolVersion;
    }
    await this._notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    return this.request("tools/call", {
      name,
      arguments: args || {},
    });
  }

  async request(method, params = {}, opts = {}) {
    if (!this.running) throw new Error("MCP connector is not running");
    try {
      return await this._request(method, params, opts);
    } catch (err) {
      // Surface the most specific failure without reassigning the catch binding.
      let failure = err;
      // 401 OAuth self-heal (方案 A, bounded to a single retry). A live request
      // came back 401: ask the runtime to force a token refresh, and if it
      // produced a new token, replay this one request with it. We retry AT MOST
 // once -a second 401, or no refresh available, falls through to failing
      // the session as needs-auth. No loop.
      if (this._is401(err) && this.refreshAuthToken) {
        const refreshed = await this._tryRefreshAndRetry(method, params, opts);
        if (refreshed.recovered) return refreshed.result;
        // Refresh produced a more specific failure (the refresh token itself is
 // dead -invalid_grant, or the retry hit a fresh error). Adopt it as the
        // failing context: a dead refresh token is auth-terminal, so _failLiveSession
        // routes it to needs-auth instead of leaving a bare 401 to back off blindly.
        if (refreshed.error) failure = refreshed.error;
      }
      // A live request failed in a way the inline 404 self-heal could not recover
      // (network drop, 5xx, unrecovered 401/403, or a dead refresh token's
      // invalid_grant). Tear the session down and report it so the runtime can run
      // backoff reconnect; auth-terminal failures additionally flag needsAuth for
      // the OAuth self-heal / re-auth. This never silently swallows the error.
      this._failLiveSession(failure);
      throw failure;
    }
  }

  _is401(err) {
    return err instanceof McpHttpError && err.status === 401;
  }

  // Force a refresh, then replay the request exactly once. Returns whether the
  // retry recovered (and its result) or carries the retry's error so the caller
  // fails the session with the most relevant context. Never recurses.
  async _tryRefreshAndRetry(method, params, opts) {
    let newToken = "";
    try {
      newToken = stringOrEmpty(await this.refreshAuthToken());
    } catch (refreshErr) {
      // Refresh itself failed. Surface that error (an invalid_grant means the
 // refresh token is dead -auth-terminal; a 5xx means transient) so the
      // caller fails the session with the more specific, correctly-classified
      // context rather than the original opaque 401.
      return { recovered: false, error: refreshErr };
    }
    // No new token but no throw (e.g. no refresh token configured): keep the
 // original 401 as the failing context -it is already auth-terminal.
    if (!newToken) return { recovered: false };
    try {
      return { recovered: true, result: await this._request(method, params, opts) };
    } catch (retryErr) {
      return { recovered: false, error: retryErr };
    }
  }

  _failLiveSession(err) {
    if (this._stopping || this._closed) return;
    // Auth-terminal (401/403, or a dead refresh token surfacing as an OAuth
 // invalid_grant from the forced refresh) -needs-auth: re-auth, never loop.
    // Everything else (network drop, 5xx, transient refresh failure) stays a
    // generic close so the runtime keeps backoff reconnect. Never swallowed.
    const needsAuth = isAuthTerminalError(err);
    this._closed = true;
    this._initialized = false;
    if (this.onClose) {
      this.onClose({
        reason: err?.message || "connection lost",
        expected: false,
        needsAuth,
      });
    }
  }

  async _request(method, params = {}, { initializing = false, retryOnSessionExpired = true } = {}) {
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    try {
      return await this._postJsonRpc(payload, { initializing });
    } catch (err) {
      if (
        retryOnSessionExpired &&
        err instanceof McpHttpError &&
        err.status === 404 &&
        this.sessionId
      ) {
        this.sessionId = "";
        this._initialized = false;
        await this.initialize();
        this._initialized = true;
        return this._request(method, params, { initializing: false, retryOnSessionExpired: false });
      }
      throw err;
    }
  }

  async _notify(method, params = {}) {
    await this._postJsonRpc({ jsonrpc: "2.0", method, params }, { initializing: false });
  }

  async stop() {
    this._stopping = true;
    this._closed = true;
    this._initialized = false;
    if (this.sessionId) {
      const sessionId = this.sessionId;
      this.sessionId = "";
      try {
        await this.fetchImpl(this.endpoint, {
          method: "DELETE",
          headers: await this._headers({ sessionId, includeJson: false }),
        });
      } catch (err) {
        this.log.debug?.(`[mcp:${this.server.id}] remote session delete failed: ${err.message}`);
      }
    }
  }

  async _headers({ sessionId = this.sessionId, includeJson = true, initializing = false } = {}) {
    const headers = {
      ...headersWithoutMcpProtocolVersion(connectorHeaders(this.server)),
      Accept: STREAMABLE_ACCEPT,
      [MCP_PROTOCOL_VERSION_HEADER]: this.protocolVersion || this.initialProtocolVersion || MCP_PROTOCOL_VERSION,
    };
    if (includeJson) headers["Content-Type"] = "application/json";
    if (sessionId && !initializing) headers["MCP-Session-Id"] = sessionId;
    // Prefer the runtime's freshest token (handles near-expiry refresh out of
    // band); fall back to the connector snapshot when no callback is injected.
    const token = await requestAuthToken(this.server, this.getAuthToken);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async _postJsonRpc(payload, { initializing = false } = {}) {
    assertValidUnicodeBoundary(payload);
    const response = await fetchWithTimeout(this.fetchImpl, this.endpoint, {
      method: "POST",
      headers: await this._headers({ initializing }),
      body: JSON.stringify(payload),
    }, requestTimeoutMs(this.server));
    if (initializing) {
      const sessionId = responseHeader(response, "MCP-Session-Id");
      if (sessionId) this.sessionId = sessionId;
    }
    if (response.status === 202 && payload.id == null) return null;
    if (!response.ok) {
      const body = await responseText(response);
      throw new McpHttpError(methodErrorMessage(response.status, body), {
        status: response.status,
        body,
        headers: response.headers,
      });
    }
    if (payload.id == null) return null;

    const contentType = responseHeader(response, "Content-Type");
    const text = await responseText(response);
    if (contentType.includes("text/event-stream")) {
      for (const event of parseSseEvents(text)) {
        if (!event.data) continue;
        const message = JSON.parse(event.data);
        if (isJsonRpcResponse(message) && message.id === payload.id) return rpcResult(message);
      }
      throw new Error(`MCP response for "${payload.method}" was not found in SSE stream`);
    }
    const message = text ? JSON.parse(text) : null;
    if (!message) return null;
    return rpcResult(message);
  }
}

export class McpLegacySseClient {
  constructor(server, { fetchImpl = globalThis.fetch, log = console, onClose = null, getAuthToken = null, refreshAuthToken = null } = {}) {
    this.server = server;
    this.fetchImpl = fetchImpl;
    this.log = log;
    // onClose({ reason, expected }) reports an unexpected stream death so the
    // runtime can run backoff reconnect; a deliberate stop() is expected.
    this.onClose = typeof onClose === "function" ? onClose : null;
    // OAuth self-heal seams (#1286 ③a); see McpStreamableHttpClient for the
 // contract. Optional -absent callbacks preserve the snapshot-token behavior.
    this.getAuthToken = typeof getAuthToken === "function" ? getAuthToken : null;
    this.refreshAuthToken = typeof refreshAuthToken === "function" ? refreshAuthToken : null;
    this.sseUrl = server?.url || "";
    this.messageEndpoint = "";
    this._nextId = 1;
    this._pending = new Map();
    this._queued = new Map();
    this._closed = true;
    this._stopping = false;
    this._buffer = "";
    this._abort = null;
    this._endpointResolve = null;
    this._endpointReject = null;
  }

  get running() {
    return !this._closed && !!this.messageEndpoint;
  }

  async start() {
    if (this.running) return;
    if (!this.sseUrl) throw new Error("MCP connector URL is required");
    this._closed = false;
    this._stopping = false;
    try {
      await this._connectSse();
      await this.initialize();
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "gsap",
        title: "G-SAP",
        version: "0.6.7",
      },
    });
    await this.notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    return this.request("tools/call", {
      name,
      arguments: args || {},
    });
  }

  async request(method, params = {}, { timeout = 30_000 } = {}) {
    if (!this.running) throw new Error("MCP connector is not running");
    try {
      return await this._sendRequest(method, params, timeout);
    } catch (err) {
      // 401 OAuth self-heal (方案 A, single retry). Force a token refresh and, if
      // it yields a new token, replay the request once with a fresh id. A second
      // 401 or no refresh rethrows. No loop.
    if (err instanceof McpHttpError && err.status === 401 && this.refreshAuthToken) {
      let newToken = "";
      newToken = stringOrEmpty(await this.refreshAuthToken());
      if (newToken) return this._sendRequest(method, params, timeout);
    }
      throw err;
    }
  }

  _sendRequest(method, params, timeout) {
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const queued = this._queued.get(id);
    if (queued) {
      this._queued.delete(id);
      return Promise.resolve(rpcResult(queued));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeout);
      this._pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this._postMessage(payload).catch((err) => {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async notify(method, params = {}) {
    if (!this.running) return;
    await this._postMessage({ jsonrpc: "2.0", method, params });
  }

  async stop() {
    this._stopping = true;
    this._closed = true;
    this.messageEndpoint = "";
    try { this._abort?.abort(); } catch {}
    this._abort = null;
    for (const pending of this._pending.values()) {
      pending.reject(new Error("MCP connector stopped"));
    }
    this._pending.clear();
  }

  async _connectSse() {
    this._abort = new AbortController();
    const endpointPromise = new Promise((resolve, reject) => {
      this._endpointResolve = resolve;
      this._endpointReject = reject;
    });
    const response = await this.fetchImpl(this.sseUrl, {
      method: "GET",
      headers: await this._headers({ accept: SSE_ACCEPT, includeJson: false }),
      signal: this._abort.signal,
    });
    if (!response.ok) {
      const body = await responseText(response);
      throw new McpHttpError(methodErrorMessage(response.status, body), {
        status: response.status,
        body,
        headers: response.headers,
      });
    }
    this._readSse(response.body).catch((err) => {
      if (!this._closed) {
        this._endpointReject?.(err);
        for (const pending of this._pending.values()) pending.reject(err);
        this._pending.clear();
      }
    });
    await withTimeout(endpointPromise, requestTimeoutMs(this.server), "MCP legacy SSE endpoint event timed out");
  }

  async _readSse(body) {
    if (!body?.getReader) {
      const text = await responseText({ text: async () => "" });
      this._consumeSse(text);
      this._handleStreamClosed("SSE stream produced no readable body");
      return;
    }
    const decoder = new TextDecoder();
    const reader = body.getReader();
    while (!this._closed) {
      const { value, done } = await reader.read();
      if (done) break;
      this._consumeSse(decoder.decode(value, { stream: true }));
    }
    this._consumeSse(decoder.decode());
    // The stream ended. Whether the remote closed it or stop() aborted it, the
 // live session is gone -clear messageEndpoint so running() stops lying
    // (the :288 stale-positive), reject any in-flight requests, and report an
    // unexpected close unless this was a deliberate stop().
    this._handleStreamClosed("SSE stream closed by remote");
  }

  _handleStreamClosed(reason) {
    const wasLive = !this._closed && !!this.messageEndpoint;
    this.messageEndpoint = "";
    if (this._stopping) return;
    if (!wasLive) return;
    this._closed = true;
    for (const pending of this._pending.values()) {
      pending.reject(new Error(reason));
    }
    this._pending.clear();
    this.onClose?.({ reason, expected: false });
  }

  _consumeSse(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = this._buffer.slice(0, index);
      this._buffer = this._buffer.slice(this._buffer[index] === "\r" ? index + 4 : index + 2);
      const [event] = parseSseEvents(block + "\n\n");
      if (event) this._handleSseEvent(event);
    }
  }

  _handleSseEvent(event) {
    if (event.event === "endpoint") {
      this.messageEndpoint = resolveEndpoint(event.data, this.sseUrl);
      this._endpointResolve?.(this.messageEndpoint);
      return;
    }
    if (!event.data) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      this.log.warn?.(`[mcp:${this.server.id}] ignored invalid SSE JSON: ${err.message}`);
      return;
    }
    if (!isJsonRpcResponse(message)) return;
    const pending = this._pending.get(message.id);
    if (!pending) {
      this._queued.set(message.id, message);
      return;
    }
    this._pending.delete(message.id);
    try {
      pending.resolve(rpcResult(message));
    } catch (err) {
      pending.reject(err);
    }
  }

  async _postMessage(payload) {
    assertValidUnicodeBoundary(payload);
    const response = await fetchWithTimeout(this.fetchImpl, this.messageEndpoint, {
      method: "POST",
      headers: await this._headers({ accept: "application/json", includeJson: true }),
      body: JSON.stringify(payload),
    }, requestTimeoutMs(this.server));
    if (!response.ok) {
      const body = await responseText(response);
      throw new McpHttpError(methodErrorMessage(response.status, body), {
        status: response.status,
        body,
        headers: response.headers,
      });
    }
  }

  async _headers({ accept, includeJson }) {
    const headers = { ...connectorHeaders(this.server), Accept: accept };
    if (includeJson) headers["Content-Type"] = "application/json";
    const token = await requestAuthToken(this.server, this.getAuthToken);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
}

export class McpAutoHttpClient {
  constructor(server, opts = {}) {
    this.server = server;
    this.opts = opts;
    this.client = null;
  }

  get running() {
    return this.client?.running === true;
  }

  async start() {
    const streamable = new McpStreamableHttpClient(this.server, this.opts);
    try {
      await streamable.start();
      this.client = streamable;
      return;
    } catch (err) {
      await streamable.stop().catch(() => {});
      if (!(err instanceof McpHttpError) || !FALLBACK_STATUSES.has(err.status)) throw err;
    }
    const legacy = new McpLegacySseClient(this.server, this.opts);
    await legacy.start();
    this.client = legacy;
  }

  async listTools() {
    return this.client.listTools();
  }

  async callTool(name, args) {
    return this.client.callTool(name, args);
  }

  async stop() {
    await this.client?.stop?.();
    this.client = null;
  }
}

function rpcResult(message) {
  if (message?.error) {
    throw new Error(message.error.message || "MCP request failed");
  }
  return message?.result;
}

function withTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function assertValidUnicodeBoundary(payload) {
  const invalid = findInvalidUnicode(payload);
  if (!invalid) return;
  throw new Error(
    `MCP connector payload contains invalid Unicode at ${invalid.path}: lone UTF-16 surrogate at index ${invalid.index}. `
    + "The original input was not modified; remove or replace the invalid character before retrying.",
  );
}

function findInvalidUnicode(value, path = "", seen = new Set()) {
  if (typeof value === "string") {
    const index = loneSurrogateIndex(value);
    return index === -1 ? null : { path: path || "value", index };
  }
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const invalid = findInvalidUnicode(value[i], `${path}[${i}]`, seen);
      if (invalid) return invalid;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const keyIndex = loneSurrogateIndex(key);
    const childPath = appendPath(path, key);
    if (keyIndex !== -1) return { path: childPath, index: keyIndex };
    const invalid = findInvalidUnicode(child, childPath, seen);
    if (invalid) return invalid;
  }
  return null;
}

function appendPath(base, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return base ? `${base}.${key}` : key;
  return `${base || "value"}[${JSON.stringify(key)}]`;
}

function loneSurrogateIndex(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        i += 1;
        continue;
      }
      return i;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return i;
  }
  return -1;
}
