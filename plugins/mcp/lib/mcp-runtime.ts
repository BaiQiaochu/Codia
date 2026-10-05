// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { McpStdioClient } from "./mcp-stdio-client.ts";
import {
  McpAutoHttpClient,
  McpHttpError,
  McpLegacySseClient,
  McpStreamableHttpClient,
  isAuthTerminalError,
  resolveMcpHttpProxyDiagnostics,
} from "./mcp-http-client.ts";
import {
  createMcpOAuthAuthorization,
  exchangeMcpOAuthCode,
  refreshMcpOAuthToken,
} from "./mcp-oauth.ts";
import { createSettingsUpdate } from "../../../lib/tools/settings-update-result.ts";

const DEFAULT_CONFIG = {
  enabled: false,
  connectors: [],
  servers: [],
};

const TRANSPORTS = new Set(["stdio", "remote", "streamable-http", "sse"]);
const AUTH_TYPES = new Set(["none", "bearer", "oauth"]);
const MASKED_SECRET = "********";

// Auto-reconnect backoff, modelled on the MCP SDK's reconnection options:
// start at 1s, double each attempt, cap at ~30s, give up after a bounded number
// of attempts and leave the connector "failed" for manual recovery. These are
// runtime-only knobs (not persisted); per-connector opt-out is `autoReconnect`.
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_GROW_FACTOR = 2;
const RECONNECT_MAX_ATTEMPTS = 8;

// Refresh an OAuth access token this long before its stated expiry, so a request
// firing right at the boundary still goes out with a valid token (clock skew +
// in-flight latency buffer). Matches the design's 60s pre-expiry window.
const OAUTH_REFRESH_LEEWAY_MS = 60_000;

// Runtime-only connector statuses layered on top of the persisted config.
// "running"/"stopped" are derived from the live client; the rest are transient
// in-memory states surfaced through getState() (and thus the stage-1 status
// tool) without ever being written to disk.
const STATUS_CONNECTING = "connecting";
const STATUS_RECONNECTING = "reconnecting";
const STATUS_FAILED = "failed";
const STATUS_NEEDS_AUTH = "needs-auth";

function normalizeTool(tool) {
  if (!tool || typeof tool.name !== "string" || !tool.name) return null;
  return {
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} },
  };
}

function normalizeConnector(connector, fallbackId = "") {
  if (!connector || typeof connector !== "object") return null;
  const id = sanitizeId(connector.id || fallbackId);
  if (!id) return null;
  const env = normalizeStringRecord(connector.env);
  const headers = normalizeStringRecord(connector.headers);
  const tools = Array.isArray(connector.tools)
    ? connector.tools.map(normalizeTool).filter(Boolean)
    : [];
  const transport = normalizeTransport(connector);
  const authorizationToken = stringOrEmpty(connector.authorizationToken || connector.authorization_token);
  const oauth = normalizeOAuthState(connector.oauth);
  const authType = normalizeAuthType(connector.authType, { authorizationToken, oauth, connector });

  return {
    id,
    name: stringOrEmpty(connector.name) || id,
    description: stringOrEmpty(connector.description),
    transport,
    url: stringOrEmpty(connector.url || connector.baseUrl),
    command: stringOrEmpty(connector.command),
    args: Array.isArray(connector.args) ? connector.args.filter((arg) => typeof arg === "string") : [],
    cwd: stringOrEmpty(connector.cwd),
    env,
    headers,
    registryUrl: stringOrEmpty(connector.registryUrl),
    timeout: normalizeTimeoutSeconds(connector.timeout),
    authType,
    authorizationToken,
    oauthClientId: stringOrEmpty(connector.oauthClientId || connector.clientId),
    oauthClientSecret: stringOrEmpty(connector.oauthClientSecret || connector.clientSecret),
    // Provenance of the OAuth client id (upstream #6 read-time migration):
    // "manual" = user-entered, "dcr" = obtained via RFC 7591 dynamic client
 // registration. Old connectors predate this field -default to "manual"
    // when a client id is already present, otherwise "" (unknown/unregistered).
    clientIdSource: normalizeClientIdSource(connector),
    oauth,
    autoStart: connector.autoStart === true || connector.isActive === true,
    // Read-time compat (upstream #7): connectors saved before auto-reconnect
    // existed have no `autoReconnect` field; default them to true so existing
    // users get keepalive without a migration script. Only an explicit `false`
    // opts out of automatic reconnection.
    autoReconnect: connector.autoReconnect !== false,
    tools,
  };
}

export function sanitizeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function toMcpToolId(serverId, toolName) {
  return sanitizeId(`${serverId}_${toolName}`);
}

export function normalizeMcpConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  const rawConnectors = Array.isArray(input.connectors)
    ? input.connectors
    : (Array.isArray(input.servers) ? input.servers : []);
  const connectors = rawConnectors
    .map((connector, index) => normalizeConnector(connector, `connector_${index + 1}`))
    .filter(Boolean);
  return {
    ...DEFAULT_CONFIG,
    enabled: input.enabled === true,
    connectors,
    servers: connectors,
  };
}

export function normalizeAgentMcpConfig(agentConfig) {
  const mcp = agentConfig?.mcp && typeof agentConfig.mcp === "object" ? agentConfig.mcp : {};
  const connectors = mcp.connectors && typeof mcp.connectors === "object"
    ? mcp.connectors
    : (mcp.servers && typeof mcp.servers === "object" ? mcp.servers : {});
  return {
    ...mcp,
    connectors,
    servers: connectors,
  };
}

export function isMcpToolEnabledForAgentConfig(agentConfig, { globalEnabled, serverId, connectorId, toolName } = {}) {
  if (globalEnabled !== true) return false;
  const id = connectorId || serverId;
  const mcp = normalizeAgentMcpConfig(agentConfig);
  const connector = mcp.connectors?.[id] || mcp.servers?.[id];
  if (connector?.enabled !== true) return false;
  return connector?.tools?.[toolName] === true;
}

export function mcpToolError(text, details = {}) {
  return {
    isError: true,
    content: [{ type: "text", text }],
    details: {
      errorCode: "mcp_unavailable",
      ...details,
    },
  };
}

export function normalizeMcpToolResult(value) {
  if (value && Array.isArray(value.content)) return value;
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null) }],
  };
}

// Unprefixed name; PluginManager.addTool prefixes the plugin id ("mcp"),
// so the agent-facing tool resolves to "mcp_connectors_status".
export const MCP_CONNECTORS_STATUS_TOOL_NAME = "connectors_status";

const MCP_CONNECTORS_STATUS_DESCRIPTION =
  "Report the live status of every configured MCP connector (running/stopped, last error, "
  + "auth state, and cached tool count). Use this to self-diagnose whether an MCP tool failure "
  + "is a connector problem (stopped/error/auth) versus an upstream API error. Read-only; takes no input.";

// Project the redacted getState() view down to the fields an agent needs for
// self-diagnosis. getState() is the single source of truth; this never reads
// connector status from anywhere else and never re-derives secrets.
function statusConnectorView(connector) {
  return {
    id: connector.id,
    name: connector.name,
    transport: connector.transport,
    status: connector.status,
    error: connector.error || "",
    authType: connector.authType,
    authStatus: connector.authStatus,
    toolCount: Array.isArray(connector.tools) ? connector.tools.length : 0,
  };
}

export function createMcpConnectorsStatusToolDefinition({ getState, getGlobalEnabled }) {
  return {
    name: MCP_CONNECTORS_STATUS_TOOL_NAME,
    description: MCP_CONNECTORS_STATUS_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    invocationStyle: "pi_tool",
    metadata: { kind: "mcp", readOnly: true },
    // Read-only diagnostics are available to any agent whenever Connectors are
    // globally enabled; they are intentionally not gated per-connector, since
    // the point is to inspect connectors the agent may not have enabled.
    isEnabledForAgentConfig: () => getGlobalEnabled() === true,
    execute: async () => {
      if (getGlobalEnabled() !== true) {
        return mcpToolError("MCP is disabled globally. Enable Connectors in Settings to inspect connector status.");
      }
      // getState() already runs every connector through publicConnector(),
      // which masks env/headers and drops tokens/secrets.
      const state = getState();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            enabled: state.enabled === true,
            connectors: (state.connectors || []).map(statusConnectorView),
          }, null, 2),
        }],
      };
    },
  };
}

export function createMcpToolDefinition({
  serverId,
  connectorId = serverId,
  toolName,
  description,
  inputSchema,
  getGlobalEnabled,
  getAgentConfig,
  callTool,
}) {
  const name = toMcpToolId(connectorId, toolName);
  return {
    name,
    description: description || `MCP connector tool ${connectorId}/${toolName}`,
    parameters: inputSchema || { type: "object", properties: {} },
    invocationStyle: "pi_tool",
    metadata: { kind: "mcp", connectorId, serverId: connectorId, toolName },
    isEnabledForAgentConfig: (agentConfig) => isMcpToolEnabledForAgentConfig(agentConfig, {
      globalEnabled: getGlobalEnabled(),
      connectorId,
      serverId: connectorId,
      toolName,
    }),
    execute: async (_toolCallId, params, runtimeCtx = {}) => {
      if (getGlobalEnabled() !== true) {
        return mcpToolError("MCP is disabled globally. Enable Connectors in Settings before calling this tool.", {
          connectorId,
          serverId: connectorId,
          toolName,
        });
      }
      const agentConfig = await getAgentConfig(runtimeCtx.agentId);
      if (!isMcpToolEnabledForAgentConfig(agentConfig, {
        globalEnabled: true,
        connectorId,
        serverId: connectorId,
        toolName,
      })) {
        return mcpToolError(`MCP connector tool "${connectorId}/${toolName}" is not enabled for this agent.`, {
          connectorId,
          serverId: connectorId,
          toolName,
          agentId: runtimeCtx.agentId || null,
        });
      }
      try {
        return normalizeMcpToolResult(await callTool(connectorId, toolName, params || {}));
      } catch (err) {
        return mcpToolError(`MCP connector tool "${connectorId}/${toolName}" failed: ${err.message}`, {
          connectorId,
          serverId: connectorId,
          toolName,
        });
      }
    },
  };
}

export class McpRuntime {
  constructor(ctx, { Client = null, clientFactory = null, fetchImpl = globalThis.fetch } = {}) {
    this.ctx = ctx;
    this.Client = Client;
    this.fetchImpl = fetchImpl;
    this.clientFactory = clientFactory || ((connector, opts) => (
      this.Client ? new this.Client(connector, opts) : createDefaultClient(connector, opts)
    ));
    this.clients = new Map();
    this.clientErrors = new Map();
    // Explicit per-connector intent. The single source of truth for "does the
 // user want this connector running-" -never inferred from clients.has(id).
    // Only desiredStates.get(id) === "running" permits auto-reconnect.
    this.desiredStates = new Map();
    // Runtime-only transient status overrides (connecting/reconnecting/failed/
    // needs-auth). Absent entry => derive running/stopped from the live client.
    this.connectorStatus = new Map();
    // In-flight backoff bookkeeping: { attempts, timer } keyed by connector id.
    this.reconnectState = new Map();
    // Connector ids whose client is currently in its start()/initialize phase.
    // While establishing, the start() promise (and its catch) is the single
    // authoritative writer; a transport's onClose firing during this window is
    // ignored so a death never gets handled twice (rejected promise + close).
    this.establishing = new Set();
    this.toolDisposers = [];
    this.oauthSessions = new Map();
    // In-flight OAuth refresh promises keyed by connector id. Guarantees a single
    // refresh per connector even under concurrent near-expiry / 401 callers.
    this.refreshInFlight = new Map();
  }

  async load() {
    fs.mkdirSync(this.ctx.dataDir, { recursive: true });
    this.registerCachedTools();
    const config = this.getConfig();
    if (config.enabled) {
      for (const connector of config.connectors.filter((s) => s.autoStart)) {
        this.startConnector(connector.id).catch((err) => {
          this.ctx.log.warn(`auto-start failed for ${connector.id}: ${err.message}`);
        });
      }
    }
  }

  async dispose() {
    for (const dispose of this.toolDisposers.splice(0)) {
      try { dispose(); } catch {}
    }
    // Stop trying to reconnect anything: a runtime teardown is a deliberate
    // close, so flip every connector's intent to stopped first.
    for (const id of this.reconnectState.keys()) {
      const state = this.reconnectState.get(id);
      if (state?.timer) clearTimeout(state.timer);
    }
    this.reconnectState.clear();
    for (const id of this.clients.keys()) {
      this.desiredStates.set(id, "stopped");
    }
    for (const client of this.clients.values()) {
      await client.stop().catch(() => {});
    }
    this.clients.clear();
    this.clientErrors.clear();
    this.connectorStatus.clear();
    this.desiredStates.clear();
    this.oauthSessions.clear();
    this.refreshInFlight.clear();
  }

  getConfig() {
    return normalizeMcpConfig(this.ctx.config.get("mcp"));
  }

  saveConfig(config) {
    const normalized = normalizeMcpConfig(config);
    this.ctx.config.set("mcp", {
      enabled: normalized.enabled,
      connectors: normalized.connectors,
    });
    return normalized;
  }

  getState(agentConfig = null) {
    const config = this.getConfig();
    const connectors = config.connectors.map((connector) => publicConnector({
      connector,
      status: this.connectorStatusFor(connector.id),
      error: this.clientErrors.get(connector.id) || "",
    }));
    return {
      enabled: config.enabled,
      connectors,
      servers: connectors,
      agentConfig: normalizeAgentMcpConfig(agentConfig),
    };
  }

  // Single status derivation: a transient runtime override (connecting/
  // reconnecting/failed/needs-auth) wins; otherwise read liveness off the
  // owning client. Never sourced from anywhere else.
  connectorStatusFor(id) {
    const override = this.connectorStatus.get(id);
    if (override) return override;
    return this.clients.get(id)?.running ? "running" : "stopped";
  }

  async setEnabled(enabled) {
    const config = this.getConfig();
    config.enabled = enabled === true;
    const saved = this.saveConfig(config);
    if (!saved.enabled) {
      for (const connector of saved.connectors) {
        await this.stopConnector(connector.id);
      }
    }
    this.registerCachedTools();
    return saved;
  }

  addConnector(input) {
    const config = this.getConfig();
    const id = uniqueConnectorId(config.connectors, input?.id || input?.name || input?.url || input?.command || "connector");
    const connector = normalizeConnector({ ...input, id }, id);
    validateConnector(connector);
    config.connectors.push(connector);
    const saved = this.saveConfig(config);
    this.registerCachedTools();
    return saved.connectors.find((s) => s.id === id);
  }

  addServer(input) {
    return this.addConnector(input);
  }

  async updateConnector(id, patch) {
    const config = this.getConfig();
    const index = config.connectors.findIndex((s) => s.id === id);
    if (index === -1) throw new Error(`MCP connector "${id}" not found`);
    const existing = config.connectors[index];
    const unmaskedPatch = unmaskConnectorPatch(existing, patch || {});
    const next = normalizeConnector({ ...existing, ...unmaskedPatch, id: existing.id, tools: patch?.tools || existing.tools }, existing.id);
    validateConnector(next);
    const changedClient = connectorClientFingerprint(next) !== connectorClientFingerprint(existing);
    config.connectors[index] = next;
    const saved = this.saveConfig(config);
    if (changedClient) await this.stopConnector(id);
    this.clientErrors.delete(id);
    this.registerCachedTools();
    return saved.connectors[index];
  }

  async updateServer(id, patch) {
    return this.updateConnector(id, patch);
  }

  async removeConnector(id) {
    await this.stopConnector(id);
    const config = this.getConfig();
    config.connectors = config.connectors.filter((s) => s.id !== id);
    const saved = this.saveConfig(config);
    this.registerCachedTools();
    return saved;
  }

  async removeServer(id) {
    return this.removeConnector(id);
  }

  async startConnector(id) {
    const config = this.getConfig();
    if (!config.enabled) throw new Error("MCP connectors are disabled globally");
    const connector = config.connectors.find((s) => s.id === id);
    if (!connector) throw new Error(`MCP connector "${id}" not found`);
    // Record intent up front: a manual/auto start means the user wants this
    // connector running, which is what later authorizes auto-reconnect.
    this.desiredStates.set(id, "running");
    // A fresh start cancels any pending backoff from a prior death.
    this._cancelReconnect(id);
    const existing = this.clients.get(id);
    if (existing?.running) {
      this.connectorStatus.delete(id);
      return connector;
    }

    const client = this._createClient(connector);
    this.clients.set(id, client);
    this.clientErrors.delete(id);
    this.connectorStatus.set(id, STATUS_CONNECTING);
    this.establishing.add(id);
    try {
      await client.start();
      await this.refreshTools(id);
      this.connectorStatus.delete(id);
      return this.getConfig().connectors.find((s) => s.id === id);
    } catch (err) {
      this.clients.delete(id);
      this.clientErrors.set(id, err.message || "MCP connector failed to start");
      this.connectorStatus.delete(id);
      await client.stop().catch(() => {});
      throw err;
    } finally {
      this.establishing.delete(id);
    }
  }

  // Build a client wired to report unexpected disconnects back to this runtime.
  // The onClose handler closes over the connector id so the reconnect decision
  // is always made against that connector's own desiredState (ownership unique).
  // It also captures the client instance: only the connector's *current* client
  // may drive a close, so a late event from an already-replaced client (e.g. a
  // stdio exit racing a successful reconnect) is harmlessly ignored.
  _createClient(connector) {
    const id = connector.id;
    const holder = {};
    holder.client = this.clientFactory(connector, {
      log: this.ctx.log,
      fetchImpl: this.fetchImpl,
      // OAuth self-heal seams (#1286 ③a, 方案 A). The client holds a connector
      // snapshot, so a refresh written to config never reaches it; these
      // callbacks let the client pull the freshest token per request and force a
      // refresh on a 401, all keyed to this connector's id (ownership unique).
      getAuthToken: () => this.getValidToken(id),
      refreshAuthToken: () => this.refreshIfPossible(id),
      onClose: (info) => {
        // Stale client (already replaced) or a death during the start phase
 // (owned by the start() promise) -ignore; otherwise handle the close.
        if (this.clients.get(id) !== holder.client) return;
        if (this.establishing.has(id)) return;
        this._onClientClose(id, info || {});
      },
    });
    return holder.client;
  }

  async startServer(id) {
    return this.startConnector(id);
  }

  async stopConnector(id) {
    // Intent first: mark stopped and tear down any pending reconnect *before*
    // touching the client, so a close event racing in during stop() can never
    // resurrect a connector the user just asked to stop.
    this.desiredStates.set(id, "stopped");
    this._cancelReconnect(id);
    this.connectorStatus.delete(id);
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    this.clientErrors.delete(id);
    await client.stop();
  }

  async stopServer(id) {
    return this.stopConnector(id);
  }

  // ── Auto-reconnect ────────────────────────────────────────────────────────
  // A transport reported that a connection died. `expected` distinguishes a
  // deliberate stop() (do nothing) from an unexpected disconnect (maybe
  // reconnect). All reconnect decisions are gated on explicit intent, never on
  // whether a client happens to be in the map.

  _onClientClose(id, info) {
    if (info.expected) return; // deliberate stop/teardown ??honour the user.

    // Auth-terminal close (401/403, or a dead refresh token's invalid_grant): the
    // connection is dead and re-trying with the same invalid credentials would
    // just fail again. Mark needs-auth and stop here; the OAuth self-heal / manual
 // re-auth consumes this state. We do NOT silently swallow the failure -the
    // error stays recorded and surfaced via getState.
    if (info.needsAuth) {
      // Auth loss is terminal for automatic recovery: retrying with the same
      // invalid credentials just fails again. Cancel any in-flight backoff first
      // so a previously-armed reconnect timer can't overwrite needs-auth, then
      // mark the state for the OAuth self-heal / manual re-auth to consume.
      this._cancelReconnect(id);
      this._markDeadClient(id, info.reason || "authentication required");
      // "Needs re-auth" is a credential fact, orthogonal to the keepalive
      // (autoReconnect) preference: report it whenever the connector is still a
      // going concern (desired-running, present, globally enabled), even when
 // autoReconnect is off -otherwise that connector would silently fall to
      // "stopped" and the user would never be told to re-authorize. This matches
      // the reconnect-attempt path, which also marks needs-auth unconditionally.
      if (this._isDesiredLiveConnector(id)) {
        this.connectorStatus.set(id, STATUS_NEEDS_AUTH);
      } else {
        // The user already stopped / removed / globally-disabled this connector:
        // there is nothing to re-auth into, so leave no stale transient override.
        this.connectorStatus.delete(id);
      }
      return;
    }

    this._markDeadClient(id, info.reason || "connection lost");
    if (!this._canAutoReconnect(id)) {
      // Reconnect not permitted (manual stop, global disable, autoReconnect off,
 // or connector removed). Leave it stopped -do not resurrect.
      this.connectorStatus.delete(id);
      return;
    }
    this._scheduleReconnect(id);
  }

  // Record the error and drop the dead client so callTool fails fast, but keep
  // the transient status override (set by the caller) driving the public view.
  _markDeadClient(id, reason) {
    const dead = this.clients.get(id);
    if (dead) {
      this.clients.delete(id);
      dead.stop?.().catch?.(() => {});
    }
    this.clientErrors.set(id, reason);
  }

  // Is this connector still one the user wants live, and that still exists and is
  //
 // going concern" -independent of the keepalive (autoReconnect) preference.
  // A needs-auth credential fact is reported whenever this holds, even when
  // autoReconnect is off (re-auth is orthogonal to retry-on-drop).
  _isDesiredLiveConnector(id) {
    if (this.desiredStates.get(id) !== "running") return false;
    const config = this.getConfig();
    if (!config.enabled) return false;
    return config.connectors.some((s) => s.id === id);
  }

  // Reconnect is permitted only when ALL intent gates agree. This is the red
  // line: a single false here means the connector stays down. It layers the
  // keepalive opt-out (autoReconnect) on top of the going-concern gates.
  _canAutoReconnect(id) {
    if (!this._isDesiredLiveConnector(id)) return false;
    const connector = this.getConfig().connectors.find((s) => s.id === id);
    return connector?.autoReconnect !== false;
  }

  _scheduleReconnect(id) {
    const prior = this.reconnectState.get(id);
    const attempts = prior?.attempts || 0;
    if (prior?.timer) clearTimeout(prior.timer);
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * RECONNECT_GROW_FACTOR ** attempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.connectorStatus.set(id, STATUS_RECONNECTING);
    const timer = setTimeout(() => {
      this._attemptReconnect(id).catch((err) => {
        this.ctx.log.warn?.(`mcp reconnect crashed for ${id}: ${err?.message || err}`);
      });
    }, delay);
    // Don't let a pending reconnect keep the process alive.
    timer.unref?.();
    this.reconnectState.set(id, { attempts, timer });
  }

  async _attemptReconnect(id) {
    // Re-check intent at fire time: the user may have stopped or disabled while
    // the backoff timer was pending.
    if (!this._canAutoReconnect(id)) {
      this._cancelReconnect(id);
      this.connectorStatus.delete(id);
      return;
    }
    const connector = this.getConfig().connectors.find((s) => s.id === id);
    const attempt = (this.reconnectState.get(id)?.attempts || 0) + 1;

    const client = this._createClient(connector);
    this.clients.set(id, client);
    this.connectorStatus.set(id, STATUS_RECONNECTING);
    // While establishing, this attempt's promise is the single authoritative
    // writer; the client's onClose is suppressed so a death during start can't
    // be handled twice (rejected promise + close event).
    this.establishing.add(id);
    try {
      await client.start();
      await this.refreshTools(id);
      // Success: live again. Clear transient state and the error, reset backoff.
      this.clientErrors.delete(id);
      this.connectorStatus.delete(id);
      this.reconnectState.delete(id);
    } catch (err) {
      this.clients.delete(id);
      await client.stop().catch(() => {});
      this.clientErrors.set(id, err?.message || "MCP reconnect failed");
      // Auth error during reconnect (token expired while the connection was
      // down): retrying with the same credentials is futile. Short-circuit to
 // needs-auth -do NOT count it as a generic failure or keep backing off.
      // The OAuth self-heal / manual re-auth consumes this; the error is kept.
      if (isAuthError(err)) {
        this._cancelReconnect(id);
        this.connectorStatus.set(id, STATUS_NEEDS_AUTH);
        return;
      }
      if (attempt >= RECONNECT_MAX_ATTEMPTS) {
 // Exhausted the budget -give up and wait for a manual start.
        this.reconnectState.delete(id);
        this.connectorStatus.set(id, STATUS_FAILED);
        this.ctx.log.warn?.(`mcp connector ${id} failed to reconnect after ${attempt} attempts`);
        return;
      }
      // Still re-checking intent before scheduling the next attempt.
      if (!this._canAutoReconnect(id)) {
        this._cancelReconnect(id);
        this.connectorStatus.delete(id);
        return;
      }
      this.reconnectState.set(id, { attempts: attempt, timer: null });
      this._scheduleReconnect(id);
    } finally {
      this.establishing.delete(id);
    }
  }

  _cancelReconnect(id) {
    const state = this.reconnectState.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.reconnectState.delete(id);
  }

  async refreshTools(id, { staleReason = "mcp.connector.refresh_tools" } = {}) {
    const client = this.clients.get(id);
    if (!client?.running) throw new Error(`MCP connector "${id}" is not running`);
    const tools = await client.listTools();
    const config = this.getConfig();
    const connector = config.connectors.find((s) => s.id === id);
    if (!connector) throw new Error(`MCP connector "${id}" not found`);
    connector.tools = tools.map(normalizeTool).filter(Boolean);
    this.saveConfig(config);
    this.registerCachedTools();
    await this._markCapabilitySnapshotsStale({
      reason: staleReason,
      connectorId: id,
    });
    return connector.tools;
  }

  async callTool(connectorId, toolName, args) {
    const config = this.getConfig();
    if (!config.enabled) throw new Error("MCP connectors are disabled globally");
    const client = this.clients.get(connectorId);
    if (!client?.running) throw new Error(`MCP connector "${connectorId}" is not running`);
    return client.callTool(toolName, args);
  }

  registerCachedTools() {
    for (const dispose of this.toolDisposers.splice(0)) {
      try { dispose(); } catch {}
    }
    const statusDefinition = createMcpConnectorsStatusToolDefinition({
      getState: () => this.getState(),
      getGlobalEnabled: () => this.getConfig().enabled,
    });
    this.toolDisposers.push(this.ctx.registerTool(statusDefinition));
    const config = this.getConfig();
    for (const connector of config.connectors) {
      for (const tool of connector.tools || []) {
        const definition = createMcpToolDefinition({
          connectorId: connector.id,
          serverId: connector.id,
          toolName: tool.name,
          description: tool.description || `${connector.name}: ${tool.title || tool.name}`,
          inputSchema: tool.inputSchema,
          getGlobalEnabled: () => this.getConfig().enabled,
          getAgentConfig: (agentId) => this.getAgentConfig(agentId),
          callTool: (connectorId, toolName, args) => this.callTool(connectorId, toolName, args),
        });
        this.toolDisposers.push(this.ctx.registerTool(definition));
      }
    }
  }

  async getAgentConfig(agentId) {
    if (!agentId || !this.ctx.bus?.request) return {};
    const result = await this.ctx.bus.request("agent:config", { agentId });
    if (result?.error) throw new Error(result.error);
    return result?.config || {};
  }

  async updateAgentMcpConnector(agentId, connectorId, patch) {
    if (!agentId) throw new Error("agentId is required");
    const current = await this.getAgentConfig(agentId);
    const existingMcp = current.mcp && typeof current.mcp === "object" ? current.mcp : {};
    const normalizedMcp = normalizeAgentMcpConfig(current);
    const connectors = normalizedMcp.connectors && typeof normalizedMcp.connectors === "object"
      ? { ...normalizedMcp.connectors }
      : {};
    const existingConnector = connectors[connectorId] && typeof connectors[connectorId] === "object"
      ? connectors[connectorId]
      : {};
    connectors[connectorId] = {
      ...existingConnector,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(patch.tools && typeof patch.tools === "object" ? { tools: { ...(existingConnector.tools || {}), ...patch.tools } } : {}),
    };
    const partial = {
      mcp: {
        ...existingMcp,
        connectors,
        servers: null,
      },
    };
    const result = await this.ctx.bus.request("agent:update-config", { agentId, partial });
    if (result?.error) throw new Error(result.error);
    return result?.config || partial;
  }

  async updateAgentMcpServer(agentId, serverId, patch) {
    return this.updateAgentMcpConnector(agentId, serverId, patch);
  }

  async _markCapabilitySnapshotsStale(payload = {}) {
    if (!this.ctx.bus?.request) return null;
    try {
      return await this.ctx.bus.request("session:capability-drift:mark-stale", payload);
    } catch (err) {
      this.ctx.log.warn?.(`mcp capability drift mark skipped: ${err?.message || err}`);
      return null;
    }
  }

  async handleSettingsAction({ action, payload = {}, agentId = null } = {}) {
    const input = isPlainObject(payload) ? payload : {};
    const changes = [];
    let stalePayload = null;
    let key = action || "mcp";
    let title = "MCP settings updated";
    let summary = "MCP settings were updated.";

    switch (action) {
      case "mcp.global.enabled": {
        const before = this.getConfig().enabled === true;
        const enabled = normalizeBoolean(input.enabled ?? input.value, "enabled");
        await this.setEnabled(enabled);
        key = "mcp.enabled";
        title = enabled ? "MCP enabled" : "MCP disabled";
        summary = enabled ? "MCP connectors are enabled globally." : "MCP connectors are disabled globally.";
        changes.push({ key, label: "MCP", before: String(before), after: String(enabled) });
        stalePayload = { reason: action };
        break;
      }

      case "mcp.connector.add": {
        const beforeEnabled = this.getConfig().enabled === true;
        if (input.enableGlobal === true && !beforeEnabled) {
          await this.setEnabled(true);
        }
        const connector = this.addConnector(connectorInputFromPayload(input));
        key = `mcp.connector.${connector.id}`;
        title = "MCP connector added";
        summary = `Added MCP connector ${connector.name || connector.id}.`;
        changes.push({ key, label: connector.name || connector.id, before: "", after: "added" });
        if (input.enableGlobal === true && !beforeEnabled) {
          changes.push({ key: "mcp.enabled", label: "MCP", before: "false", after: "true" });
        }
        stalePayload = { reason: action, connectorId: connector.id };
        break;
      }

      case "mcp.connector.update": {
        const connectorId = connectorIdFromPayload(input);
        const connector = await this.updateConnector(connectorId, connectorPatchFromPayload(input));
        key = `mcp.connector.${connector.id}`;
        title = "MCP connector updated";
        summary = `Updated MCP connector ${connector.name || connector.id}.`;
        changes.push({ key, label: connector.name || connector.id, before: "configured", after: "updated" });
        stalePayload = { reason: action, connectorId: connector.id };
        break;
      }

      case "mcp.connector.remove": {
        const connectorId = connectorIdFromPayload(input);
        const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
        await this.removeConnector(connectorId);
        key = `mcp.connector.${connectorId}`;
        title = "MCP connector removed";
        summary = `Removed MCP connector ${connector?.name || connectorId}.`;
        changes.push({ key, label: connector?.name || connectorId, before: "present", after: "removed" });
        stalePayload = { reason: action, connectorId };
        break;
      }

      case "mcp.connector.start": {
        const connectorId = connectorIdFromPayload(input);
        const connector = await this.startConnector(connectorId);
        key = `mcp.connector.${connector.id}`;
        title = "MCP connector started";
        summary = `Started MCP connector ${connector.name || connector.id}.`;
        changes.push({ key, label: connector.name || connector.id, before: "stopped", after: "running" });
        break;
      }

      case "mcp.connector.stop": {
        const connectorId = connectorIdFromPayload(input);
        const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
        await this.stopConnector(connectorId);
        key = `mcp.connector.${connectorId}`;
        title = "MCP connector stopped";
        summary = `Stopped MCP connector ${connector?.name || connectorId}.`;
        changes.push({ key, label: connector?.name || connectorId, before: "running", after: "stopped" });
        stalePayload = { reason: action, connectorId };
        break;
      }

      case "mcp.connector.refresh_tools": {
        const connectorId = connectorIdFromPayload(input);
        const tools = await this.refreshTools(connectorId, { staleReason: action });
        const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
        key = `mcp.connector.${connectorId}.tools`;
        title = "MCP tools refreshed";
        summary = `Refreshed ${tools.length} MCP tools for ${connector?.name || connectorId}.`;
        changes.push({ key, label: `${connector?.name || connectorId} tools`, before: "cached", after: String(tools.length) });
        break;
      }

      case "mcp.agent.connector.enable": {
        const targetAgentId = agentId || stringOrEmpty(input.agentId);
        const connectorId = connectorIdFromPayload(input);
        const enabled = normalizeBoolean(input.enabled ?? input.value, "enabled");
        await this.updateAgentMcpConnector(targetAgentId, connectorId, { enabled });
        const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
        key = `mcp.agent.${targetAgentId}.connector.${connectorId}`;
        title = enabled ? "MCP connector enabled for agent" : "MCP connector disabled for agent";
        summary = `${connector?.name || connectorId} is ${enabled ? "enabled" : "disabled"} for this agent.`;
        changes.push({ key, label: connector?.name || connectorId, before: "", after: String(enabled) });
        stalePayload = { reason: action, agentId: targetAgentId, connectorId };
        break;
      }

      case "mcp.agent.tool.enable": {
        const targetAgentId = agentId || stringOrEmpty(input.agentId);
        const connectorId = connectorIdFromPayload(input);
        const toolName = stringOrEmpty(input.toolName || input.name);
        if (!toolName) throw new Error("toolName is required");
        const enabled = normalizeBoolean(input.enabled ?? input.value, "enabled");
        await this.updateAgentMcpConnector(targetAgentId, connectorId, { tools: { [toolName]: enabled } });
        key = `mcp.agent.${targetAgentId}.connector.${connectorId}.tool.${toolName}`;
        title = enabled ? "MCP tool enabled for agent" : "MCP tool disabled for agent";
        summary = `${connectorId}/${toolName} is ${enabled ? "enabled" : "disabled"} for this agent.`;
        changes.push({ key, label: `${connectorId}/${toolName}`, before: "", after: String(enabled) });
        stalePayload = { reason: action, agentId: targetAgentId, connectorId };
        break;
      }

      default:
        throw new Error(`Unknown MCP settings action: ${action}`);
    }

    if (stalePayload) {
      await this._markCapabilitySnapshotsStale(stalePayload);
    }

    return {
      settingsUpdate: createSettingsUpdate({
        status: "applied",
        action,
        key,
        title,
        summary,
        changes,
      }),
    };
  }

  async startOAuth(connectorId, redirectUri) {
    const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
    if (!connector) throw new Error(`MCP connector "${connectorId}" not found`);
    const { url, session } = await createMcpOAuthAuthorization({
      connector,
      redirectUri,
      fetchImpl: this.fetchImpl,
    });
    this.oauthSessions.set(session.state, { status: "pending", ...session });
    return { sessionId: session.state, url };
  }

  async completeOAuth({ state, code, error }) {
    const session = this.oauthSessions.get(state);
    if (!session) throw new Error("OAuth session not found");
    if (error) {
      session.status = "error";
      session.error = error;
      return session;
    }
    try {
      const token = await exchangeMcpOAuthCode({
        tokenEndpoint: session.tokenEndpoint,
        code,
        redirectUri: session.redirectUri,
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        codeVerifier: session.codeVerifier,
        resource: session.resource,
        fetchImpl: this.fetchImpl,
      });
      // Full authorization (user logged in): persist the token AND any client
      // registration the session obtained via DCR, then stop so the next start
      // rebuilds the live client against the new credentials.
      await this.saveConnectorOAuth(session.connectorId, token, {
        clientRegistration: {
          clientId: stringOrEmpty(session.clientId),
          clientSecret: stringOrEmpty(session.clientSecret),
          clientIdSource: stringOrEmpty(session.clientIdSource),
        },
      });
      session.status = "done";
      session.result = { connectorId: session.connectorId };
      return session;
    } catch (err) {
      session.status = "error";
      session.error = err.message;
      throw err;
    }
  }

  getOAuthStatus(sessionId) {
    const session = this.oauthSessions.get(sessionId);
    if (!session) return { status: "missing" };
    if (session.status === "done") return { status: "done", result: session.result || null };
    if (session.status === "error") return { status: "error", error: session.error || "OAuth failed" };
    return { status: "pending" };
  }

  // Full-authorization write-back (initial login / re-login). Persists the token
  // and any DCR client registration, then STOPS the connector so the next start
  // rebuilds the live client (which snapshots the connector) against the new
  // credentials. This is the only OAuth write path that tears down the client.
  async saveConnectorOAuth(connectorId, token, { clientRegistration = null } = {}) {
    this._writeConnectorOAuth(connectorId, token, clientRegistration);
    const saved = await this.stopConnector(connectorId).then(() => this.getConfig());
    const connector = saved.connectors.find((item) => item.id === connectorId);
    if (!connector) throw new Error(`MCP connector "${connectorId}" not found after OAuth save`);
    if (!stringOrEmpty(connector.oauth?.accessToken)) {
      throw new Error(`OAuth token was not persisted for MCP connector "${connectorId}"`);
    }
    return connector;
  }

  // Pure persistence of OAuth credentials onto a connector. No client lifecycle
 // side effects -callers decide whether to stop/restart. Centralizing the
  // write keeps the oauth/expiresAt/DCR fields in exactly one place.
  _writeConnectorOAuth(connectorId, token, clientRegistration = null) {
    const config = this.getConfig();
    const connector = config.connectors.find((item) => item.id === connectorId);
    if (!connector) throw new Error(`MCP connector "${connectorId}" not found`);
    connector.authType = "oauth";
    connector.authorizationToken = "";
    if (clientRegistration?.clientId) {
      connector.oauthClientId = clientRegistration.clientId;
      connector.oauthClientSecret = clientRegistration.clientSecret || "";
      connector.clientIdSource = clientRegistration.clientIdSource || "manual";
    }
    connector.oauth = {
      ...token,
      expiresAt: token.expiresIn ? token.obtainedAt + token.expiresIn * 1000 : 0,
    };
    return this.saveConfig(config);
  }

  // Return a usable access token for a connector, refreshing it in place when it
  // is within 60s of expiry (RFC 6749 §6). The refreshed token is written back
 // WITHOUT stopping the connector -a live client picks it up via the injected
  // getAuthToken callback, so an in-use session is never torn down by a refresh.
  // Concurrent callers are deduplicated onto a single in-flight refresh promise.
  async getValidToken(connectorId) {
    const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
    const oauth = connector?.oauth || {};
    const accessToken = stringOrEmpty(oauth.accessToken);
    const refreshToken = stringOrEmpty(oauth.refreshToken);
    const expiresAt = Number(oauth.expiresAt || 0) || 0;
    const nearExpiry = expiresAt > 0 && Date.now() > expiresAt - OAUTH_REFRESH_LEEWAY_MS;
    if (!nearExpiry || !refreshToken) return accessToken;
    return this._refreshConnectorToken(connectorId);
  }

  // Force a refresh if the connector still has a refresh token, returning the new
  // access token (or "" if refresh is impossible). Used by the 401 self-heal path.
  async refreshIfPossible(connectorId) {
    const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
    const refreshToken = stringOrEmpty(connector?.oauth?.refreshToken);
    if (!refreshToken) return "";
    return this._refreshConnectorToken(connectorId);
  }

  // Single in-flight refresh per connector: many requests hitting a near-expiry
  // (or 401) at once must not fire N parallel refreshes that race each other's
  // write-back. The first caller starts the refresh; the rest await the same
  // promise. The map entry is cleared on settle so a later expiry refreshes anew.
  _refreshConnectorToken(connectorId) {
    const inFlight = this.refreshInFlight.get(connectorId);
    if (inFlight) return inFlight;
    const promise = this._doRefreshConnectorToken(connectorId)
      .finally(() => {
        if (this.refreshInFlight.get(connectorId) === promise) {
          this.refreshInFlight.delete(connectorId);
        }
      });
    this.refreshInFlight.set(connectorId, promise);
    return promise;
  }

  async _doRefreshConnectorToken(connectorId) {
    const connector = this.getConfig().connectors.find((item) => item.id === connectorId);
    if (!connector) throw new Error(`MCP connector "${connectorId}" not found`);
    const oauth = connector.oauth || {};
    const refreshToken = stringOrEmpty(oauth.refreshToken);
    if (!refreshToken) throw new Error(`MCP connector "${connectorId}" has no refresh token`);
    const token = await refreshMcpOAuthToken({
      tokenEndpoint: stringOrEmpty(oauth.tokenEndpoint),
      refreshToken,
      clientId: stringOrEmpty(connector.oauthClientId),
      clientSecret: stringOrEmpty(connector.oauthClientSecret),
      scope: stringOrEmpty(oauth.scope),
      resource: stringOrEmpty(connector.url),
      fetchImpl: this.fetchImpl,
    });
    // Refresh write-back: persist WITHOUT stopping the connector.
    this._writeConnectorOAuth(connectorId, token);
    return stringOrEmpty(token.accessToken);
  }

  async logoutOAuth(connectorId) {
    const config = this.getConfig();
    const connector = config.connectors.find((item) => item.id === connectorId);
    if (!connector) throw new Error(`MCP connector "${connectorId}" not found`);
    connector.oauth = {};
    connector.authorizationToken = "";
    const saved = this.saveConfig(config);
    await this.stopConnector(connectorId);
    return saved.connectors.find((item) => item.id === connectorId);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Classify a reconnect/start error as auth-terminal (re-auth required, retrying
// is futile). Delegates to the shared classifier so the rule is identical at the
// live-request layer (_failLiveSession) and here: an HTTP 401/403, OR a dead
// refresh token surfacing as an OAuth invalid_grant (HTTP 400) from the
// pre-request refresh during start(). Used to short-circuit reconnect into
// needs-auth instead of burning the whole backoff budget re-hammering the AS.
function isAuthError(err) {
  return isAuthTerminalError(err);
}

function normalizeBoolean(value, fieldName) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${fieldName} must be boolean`);
}

function connectorIdFromPayload(payload) {
  const id = sanitizeId(payload.connectorId || payload.serverId || payload.id);
  if (!id) throw new Error("connectorId is required");
  return id;
}

function connectorInputFromPayload(payload) {
  const source = isPlainObject(payload.connector) ? payload.connector : payload;
  return omitKeys(source, ["connector", "connectorId", "serverId", "enableGlobal", "enabled", "value"]);
}

function connectorPatchFromPayload(payload) {
  const source = isPlainObject(payload.patch) ? payload.patch : payload;
  return omitKeys(source, ["connectorId", "serverId", "id", "patch", "value"]);
}

function omitKeys(source, keys) {
  const blocked = new Set(keys);
  return Object.fromEntries(
    Object.entries(source || {}).filter(([key]) => !blocked.has(key)),
  );
}

function createDefaultClient(connector, opts) {
  if (connector.transport === "stdio") return new McpStdioClient(connector, opts);
  if (connector.transport === "streamable-http") return new McpStreamableHttpClient(connector, opts);
  if (connector.transport === "sse") return new McpLegacySseClient(connector, opts);
  return new McpAutoHttpClient(connector, opts);
}

function normalizeTransport(connector) {
  const raw = stringOrEmpty(connector.transport || connector.type);
  if (raw === "http") return "remote";
  if (raw === "streamableHttp" || raw === "streamable-http") return "streamable-http";
  if (TRANSPORTS.has(raw)) return raw;
  if (stringOrEmpty(connector.url || connector.baseUrl)) return "remote";
  return "stdio";
}

function normalizeAuthType(value, { authorizationToken, oauth, connector }) {
  const raw = stringOrEmpty(value);
  if (AUTH_TYPES.has(raw)) return raw;
  if (authorizationToken) return "bearer";
  if (oauth.accessToken || connector.oauthClientId || connector.clientId) return "oauth";
  return "none";
}

function normalizeClientIdSource(connector) {
  const raw = stringOrEmpty(connector.clientIdSource);
  if (raw === "manual" || raw === "dcr") return raw;
  return stringOrEmpty(connector.oauthClientId || connector.clientId) ? "manual" : "";
}

function normalizeOAuthState(value) {
  if (!value || typeof value !== "object") return {};
  return {
    accessToken: stringOrEmpty(value.accessToken),
    refreshToken: stringOrEmpty(value.refreshToken),
    tokenType: stringOrEmpty(value.tokenType) || (value.accessToken ? "Bearer" : ""),
    tokenEndpoint: stringOrEmpty(value.tokenEndpoint),
    scope: stringOrEmpty(value.scope),
    expiresIn: Number(value.expiresIn || 0) || 0,
    expiresAt: Number(value.expiresAt || 0) || 0,
    obtainedAt: Number(value.obtainedAt || 0) || 0,
  };
}

function validateConnector(connector) {
  if (!connector) throw new Error("connector is required");
  if (connector.transport === "stdio") {
    if (!connector.command) throw new Error("command is required");
    return;
  }
  if (!connector.url) throw new Error("url is required");
  const url = new URL(connector.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
}

function uniqueConnectorId(connectors, raw) {
  const base = sanitizeId(raw) || "connector";
  const taken = new Set(connectors.map((s) => s.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function connectorClientFingerprint(connector) {
  return JSON.stringify({
    transport: connector.transport,
    url: connector.url,
    command: connector.command,
    args: connector.args,
    cwd: connector.cwd,
    env: connector.env,
    headers: connector.headers,
    registryUrl: connector.registryUrl,
    timeout: connector.timeout,
    authType: connector.authType,
    authorizationToken: connector.authorizationToken,
    oauthAccessToken: connector.oauth?.accessToken || "",
  });
}

function publicConnector({ connector, status, error = "" }) {
  return {
    ...connector,
    status,
    error,
    env: redactRecord(connector.env),
    headers: redactRecord(connector.headers),
    authorizationToken: connector.authorizationToken ? "********" : "",
    oauthClientSecret: connector.oauthClientSecret ? "********" : "",
    oauth: {
      connected: !!connector.oauth?.accessToken,
      scope: connector.oauth?.scope || "",
      expiresAt: connector.oauth?.expiresAt || 0,
    },
    proxy: resolveMcpHttpProxyDiagnostics(connector),
    authStatus: connectorAuthStatus(connector),
  };
}

function connectorAuthStatus(connector) {
  if (connector.authType === "none") return "none";
  if (connector.authType === "bearer") return connector.authorizationToken ? "token" : "missing";
  if (connector.authType === "oauth") return connector.oauth?.accessToken ? "connected" : "disconnected";
  return "none";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, val]) => typeof key === "string" && typeof val === "string"),
  );
}

function normalizeTimeoutSeconds(value) {
  if (value === "" || value == null) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function redactRecord(value) {
  const record = normalizeStringRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, val]) => [key, val ? MASKED_SECRET : ""]),
  );
}

function unmaskConnectorPatch(existing, patch) {
  const next = { ...patch };
  if (patch.authorizationToken === MASKED_SECRET) {
    next.authorizationToken = existing.authorizationToken || "";
  }
  if (patch.oauthClientSecret === MASKED_SECRET) {
    next.oauthClientSecret = existing.oauthClientSecret || "";
  }
  if (patch.env && typeof patch.env === "object" && !Array.isArray(patch.env)) {
    next.env = unmaskRecord(existing.env, patch.env);
  }
  if (patch.headers && typeof patch.headers === "object" && !Array.isArray(patch.headers)) {
    next.headers = unmaskRecord(existing.headers, patch.headers);
  }
  return next;
}

function unmaskRecord(existing, patch) {
  const existingRecord = normalizeStringRecord(existing);
  const patchRecord = normalizeStringRecord(patch);
  return Object.fromEntries(
    Object.entries(patchRecord).map(([key, val]) => [
      key,
      val === MASKED_SECRET && Object.hasOwn(existingRecord, key) ? existingRecord[key] : val,
    ]),
  );
}

export function configPathForDataDir(dataDir) {
  return path.join(dataDir, "config.json");
}
