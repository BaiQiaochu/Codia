import { createModelQualificationRoute } from "./routes/model-qualification.ts";
import { createToolActionsRoute } from "./routes/tool-actions.ts";
import { createTaskArtifactsRoute } from "./routes/task-artifacts.ts";
import { createWorkflowRecoveryRoute } from "./routes/workflow-recovery.ts";
import { createTaskConsoleRoute } from "./routes/task-console.ts";
/**
 * Local application server - HTTP + WebSocket API.
 *
 * Start modes:
 *   node server/index.ts
 *   forked by Electron main process
 *
 * When forked, the server reports its port to the parent process over IPC.
 */
import crypto from "crypto";
import fs from "fs";
import { setMaxListeners } from "events";
import path from "path";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import type { HttpBindings, ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocketServer } from "ws";
import { AppError } from "../shared/errors.ts";
import { errorBus } from "../shared/error-bus.ts";
import { CodiaEngine } from "../core/engine.ts";
import { ensureFirstRun } from "../core/first-run.ts";
import { initDebugLog } from "../lib/debug-log.ts";
import { redactLogLabel, redactLogText } from "../lib/log-redactor.ts";
import { safeJson } from "./hono-helpers.ts";
import { extractAccessTokenFromHono, extractAccessTokenFromNodeRequest } from "./access-token.ts";
import { createOutboundProxyRuntime } from "../lib/net/outbound-proxy.ts";
import { createServerAuthService } from "../core/server-auth.ts";
import { resolveServerListenOptions } from "../core/server-network-config.ts";
import { createCorsMiddleware } from "./http/cors-policy.ts";
import { inferHttpConnectionKind } from "./http/transport-context.ts";
import { authorizeHttpRoute, isPublicHttpRoute } from "./http/route-security.ts";
import { resolveHttpRequestPrincipal } from "./http/request-principal.ts";
import {
  runWin32LegacySandboxMigration,
  summarizeWin32LegacySandboxMigration,
} from "../lib/sandbox/win32-legacy-migration.ts";

// Pi SDK fetch can accumulate AbortSignal listeners during long sessions.

import { loadLocale } from "../lib/i18n.ts";
import { createChatRoute } from "./routes/chat.ts";
import { createSessionsRoute } from "./routes/sessions.ts";
import { createSessionProjectsRoute } from "./routes/session-projects.ts";
import { createStudioWorkspacesRoute } from "./routes/studio-workspaces.ts";
import { createSettingsSnapshotRoute } from "./routes/settings-snapshot.ts";
import { createModelsRoute } from "./routes/models.ts";
import { createConfigRoute } from "./routes/config.ts";
import { createUploadRoute } from "./routes/upload.ts";
import { createResourcesRoute } from "./routes/resources.ts";
import { createCardsRoute } from "./routes/cards.ts";
import { createResourceIoRoute } from "./routes/resource-io.ts";
import { createProvidersRoute } from "./routes/providers.ts";
import { createAvatarRoute } from "./routes/avatar.ts";
import { createAgentsRoute } from "./routes/agents.ts";
import { createDeskRoute } from "./routes/desk.ts";
import { createSkillsRoute } from "./routes/skills.ts";
import { createCharacterCardsRoute } from "./routes/character-cards.ts";
import { createChannelsRoute } from "./routes/channels.ts";
import { createDmRoute } from "./routes/dm.ts";
import { createFsRoute } from "./routes/fs.ts";
import { createPreferencesRoute } from "./routes/preferences.ts";
import { createExperimentsRoute } from "./routes/experiments.ts";
import { createBridgeRoute } from "./routes/bridge.ts";
import { createWukongRoute } from "./routes/wukong.ts";
import { createAuthRoute } from "./routes/auth.ts";
import { createDiaryRoute } from "./routes/diary.ts";
import { createConfirmRoute } from "./routes/confirm.ts";
import {
  createPluginsRoute,
  verifyPluginIframeTicketForHostRequest,
} from "./routes/plugins.ts";
import { PluginIframeTicketError } from "../core/plugin-iframe-ticket-service.ts";
import { PluginAssetSessionError } from "../core/plugin-asset-session-service.ts";
import {
  isMalformedPluginAssetRequest,
  isPluginAssetRequest,
  verifyPluginAssetSessionForHostRequest,
} from "./http/plugin-assets.ts";
import { createCheckpointsRoute } from "./routes/checkpoints.ts";
import { createCommandsRoute } from "./routes/commands.ts";
import { createPromptsRoute } from "./routes/prompts.ts";
import { createServerIdentityRoute } from "./routes/server-identity.ts";
import { createSystemHealthRoute } from "./routes/system-health.ts";
import { createRuntimeDiagnosticsRoute } from "./routes/runtime-diagnostics.ts";
import { createRuntimeDiagnosticsService } from "./runtime-diagnostics-service.ts";
import { createVoiceRoute } from "./routes/voice.ts";
import { createSpeechRecognitionRoute } from "./routes/speech-recognition.ts";
import { createMediaRoute } from "./routes/media.ts";
import { createAccessRoute } from "./routes/access.ts";
import { createDevicesRoute } from "./routes/devices.ts";
import { createMobileWorkbenchRoute } from "./routes/mobile-workbench.ts";
import { createMobileStaticRoute } from "./routes/mobile-static.ts";
import { createHtmlPreviewRoute } from "./routes/html-preview.ts";
import { createPwaAuth } from "./pwa-auth.ts";
import { createWebAuthRoute } from "./routes/web-auth.ts";
import { createWebSocketAuthRoute } from "./routes/ws-auth.ts";
import { createUsageRoute } from "./routes/usage.ts";
import { createUsageMaintenanceRoute } from "./routes/usage-maintenance.ts";
import { createWorkspaceToolsRoute } from "./routes/workspace-tools.ts";
import { normalizePrincipal } from "../core/security-principal.ts";
import { createWebSocketTicketService } from "../core/ws-auth-ticket.ts";
import { resolveSessionThinkingLevelState } from "./session-thinking-level-state.ts";
// internal-browser WS is handled directly via raw ws.WebSocketServer in the
// upgrade handler below (WsTransport needs raw ws .on()/.off() methods)
import { ConfirmStore } from "../lib/confirm-store.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import { SubagentRunStore } from "../lib/subagent-run-store.ts";
import { SubagentThreadStore } from "../lib/subagent-thread-store.ts";
import { ActivityHub } from "../lib/activity-hub.ts";
import { WorkflowActivityStore } from "../lib/workflow-activity-store.ts";
import { createDeferredResultExtension } from "../lib/extensions/deferred-result-ext.ts";
import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";
import { getResolvedCompactionMode } from "../shared/compaction-mode.ts";
import { registerDeferredResultBusHandlers } from "./deferred-result-bus-handlers.ts";
import { registerTaskRegistryBusHandlers } from "./task-bus-handlers.ts";
import { Hub } from "../hub/index.ts";
import { startCLI } from "./cli.ts";
import { fromRoot } from "../shared/app-root.ts";
import { callText } from "../core/llm-client.ts";
import {
  applyCodiaHomeEnv,
  configureProcessPiSdkEnv,
  ensureCodiaPiSdkDirs,
  resolveCodiaHome,
  resolveServerInfoPath,
} from "../shared/codia-runtime-paths.ts";

setMaxListeners(50);

const productDir = fromRoot("lib");

type StartupPayload = {
  code: string;
  host: string;
  port: number;
  listenHost: string;
  networkMode: string;
  suggestions: string[];
};

type StartupError = Error & {
  code?: string;
  startupPayload?: StartupPayload;
  cause?: unknown;
};

type ServerFetchCallback = (request: Request, env?: unknown) => Promise<unknown> | unknown;

type ServerRuntimeContext = {
  Bindings: HttpBindings;
  Variables: {
    transportConnectionKind: string;
    pwaSession: unknown;
    authPrincipal: unknown;
  };
};

type UtilityCallTextPayload = {
  sessionPath?: unknown;
  agentId?: unknown;
  systemPrompt?: string;
  messages?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  timeoutMs?: unknown;
  signal?: unknown;
  operation?: string;
};

type AuthPrincipalValue = ServerRuntimeContext["Variables"]["authPrincipal"];

function getErrorCode(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code || "")
    : "";
}

async function bindServerTransportOwnership(
  server: ServerType,
  { host, port, listenHost, networkMode }: { host: string; port: number; listenHost: string; networkMode: string },
) {
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(port, host);
    });
  } catch (err) {
    const startupError = (isAddressInUseError(err)
      ? createPortInUseStartupError(err, { host, port, listenHost, networkMode })
      : isListenPermissionError(err)
      ? createListenPermissionStartupError(err, { host, port, listenHost, networkMode })
      : err) as StartupError;
    if (startupError.startupPayload) {
      console.error(`[server] startup-error ${JSON.stringify(startupError.startupPayload)}`);
    }
    console.error("[server] startup failed:", startupError.message);
    process.exit(1);
  }
}

function isAddressInUseError(err: unknown) {
  return getErrorCode(err) === "EADDRINUSE";
}

function isListenPermissionError(err: unknown) {
  return getErrorCode(err) === "EACCES";
}

function createPortInUseStartupError(
  cause: unknown,
  { host, port, listenHost, networkMode }: { host: string; port: number; listenHost: string; networkMode: string },
): StartupError {
  const payload = {
    code: "PORT_IN_USE",
    host,
    port,
    listenHost,
    networkMode,
    suggestions: [
      `Close the process already listening on ${host}:${port}.`,
      "If this is another local app service, restart that instance or quit it cleanly.",
      "To use a different port, change the port in Access & Devices and restart.",
    ],
  };
  const err = new Error(
    `PORT_IN_USE: ${host}:${port} is already in use (network mode: ${networkMode}, configured host: ${listenHost}).`,
  ) as StartupError;
  err.code = "PORT_IN_USE";
  err.startupPayload = payload;
  err.cause = cause;
  return err;
}

function createListenPermissionStartupError(
  cause: unknown,
  { host, port, listenHost, networkMode }: { host: string; port: number; listenHost: string; networkMode: string },
): StartupError {
  const payload = {
    code: "LISTEN_PERMISSION_DENIED",
    host,
    port,
    listenHost,
    networkMode,
    suggestions: [
      `Check whether Windows reserved port policy or security software blocks listening on ${host}:${port}.`,
      "Use loopback mode for local-only access, or enable LAN from Access & Devices and restart.",
      "To use a different port, change the port in Access & Devices and restart.",
    ],
  };
  const err = new Error(
    `LISTEN_PERMISSION_DENIED: ${host}:${port} cannot be listened on (network mode: ${networkMode}, configured host: ${listenHost}).`,
  ) as StartupError;
  err.code = "LISTEN_PERMISSION_DENIED";
  err.startupPayload = payload;
  err.cause = cause;
  return err;
}

const codiaHome = resolveCodiaHome();
applyCodiaHomeEnv(codiaHome);
ensureCodiaPiSdkDirs(codiaHome);
configureProcessPiSdkEnv(codiaHome);
const serverInfoPath = resolveServerInfoPath(codiaHome);
const serverInfoScope = process.env.CODIA_SERVER_SCOPE || "default";

// Read app version before the startup placeholder begins serving health checks.
let appVersion = "?";
try {
  const pkg = JSON.parse(fs.readFileSync(fromRoot("package.json"), "utf-8"));
  appVersion = pkg.version || "?";
} catch {
  // Keep fallback version marker when package.json is unavailable.
}

const serverNetwork = resolveServerListenOptions(codiaHome);
const envPort = Number.parseInt(process.env.CODIA_PORT || "", 10);
const port = Number.isInteger(envPort) && envPort >= 0 ? envPort : serverNetwork.port;
const host = serverNetwork.host;
const accessRuntimeState = {
  mode: serverNetwork.mode,
  listenHost: serverNetwork.host,
  actualPort: null,
  applyNetworkConfig(network) {
    this.mode = network.mode;
    this.listenHost = network.listenHost;
  },
};

let activeFetch: ServerFetchCallback = (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return Response.json({
      status: "starting",
      version: appVersion,
      networkMode: accessRuntimeState.mode,
      configuredHost: accessRuntimeState.listenHost,
    }, { status: 503 });
  }
  return Response.json({ error: "server_starting" }, { status: 503 });
};

const server = createAdaptorServer({
  fetch: (...args) => activeFetch(...args),
  hostname: host,
});

await bindServerTransportOwnership(server, {
  host,
  port,
  listenHost: serverNetwork.host,
  networkMode: serverNetwork.mode,
});

//
console.log("[server] ensureFirstRun...");
ensureFirstRun(codiaHome, productDir);
console.log("[server] ensureFirstRun 完成");

//
const dlog = initDebugLog(path.join(codiaHome, "logs"));

//
console.log("[server] 创建应用引擎...");
const engine = new CodiaEngine({ codiaHome: codiaHome, productDir });
console.log("[server] application engine constructed; starting init...");
await engine.init((msg) => console.log(`[server] ${msg}`));
console.log("[server] engine.init 完成");
dlog.log("server", "engine initialized");

if (process.platform === "win32") {
  const workspaceRoots = [
    engine.homeCwd,
    ...(Array.isArray(engine.config?.cwd_history) ? engine.config.cwd_history : []),
  ].filter(Boolean);
  runWin32LegacySandboxMigration({
    codiaHome: engine.codiaHome || codiaHome,
    workspaceRoots,
    cleanup: true,
  } as any).then((result) => {
    const summary = summarizeWin32LegacySandboxMigration(result);
    const level = result?.status === "failed" ? "warn" : "log";
    dlog[level]("win32-sandbox", `legacy migration ${summary}`);
    if (result?.stderr) dlog.warn("win32-sandbox", result.stderr);
  }).catch((err) => {
    dlog.warn("win32-sandbox", `legacy migration failed: ${err?.message || err}`);
  });
}

const outboundProxyRuntime = createOutboundProxyRuntime({
  log: (msg) => dlog.log("server", msg),
} as any);
engine.setOutboundProxyRuntime(outboundProxyRuntime);
outboundProxyRuntime.apply(engine.getNetworkProxy());

// Inject runtime paths into BrowserManager without creating a module cycle.
import { BrowserManager } from "../lib/browser/browser-manager.ts";
BrowserManager.setCodiaHome(engine.codiaHome);
BrowserManager.setSessionIdResolver((sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null);

// Write the startup diagnostics header.
dlog.header(appVersion, {
  model: engine.currentModel?.name || "(none)",
  agent: engine.agentName,
  agentId: engine.currentAgentId, // @ui-focus-ok: startup log
  utilityModel: (() => { try { return engine.resolveUtilityConfig?.()?.utility?.id || "(none)"; } catch { return "(none)"; } })(),
  channelsDir: engine.channelsDir,
});

// Initialize Hub after engine startup.
const hub = new Hub({ engine });

// Register compaction framework before plugin startup lifecycles so plugin SDK
// consumers can see the compaction tool contract during initialization.
await engine.registerExtensionFactory(createCompactionGuardExtension({
  usageLedger: engine.usageLedger,
  getCompactionMode: () => getResolvedCompactionMode(engine.preferences),
  buildSessionCacheSnapshot: (sessionPath, options) => engine.buildSessionCacheSnapshot(sessionPath, options),
  buildUsageContext: ({ ctx }) => {
    const sessionPath = ctx?.sessionManager?.getSessionFile?.() || null;
    const bridgeContext = sessionPath ? engine.getBridgeContextForSessionPath(sessionPath) : null;
    if (bridgeContext?.isBridgeSession) {
      const conversationType = bridgeContext.chatType === "channel" ? "channel" : "dm";
      return {
        source: {
          subsystem: "compaction",
          operation: "fresh_compact",
          surface: conversationType,
          trigger: "threshold",
        },
        attribution: {
          kind: "phone_conversation",
          agentId: bridgeContext.agentId || null,
          conversationId: bridgeContext.sessionKey || bridgeContext.chatId || sessionPath,
          conversationType,
          sessionPath,
        },
      };
    }
    return {
      source: {
        subsystem: "compaction",
        operation: "compact",
        surface: "desktop",
        trigger: "threshold",
      },
      attribution: {
        kind: "session",
        agentId: sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null,
        sessionPath,
      },
    };
  },
}));

// Initialize plugin system.
await engine.initPlugins(hub.eventBus);

// Start Hub schedulers.
hub.initSchedulers();

engine.cleanupCheckpoints().catch(err => {
  console.warn("[checkpoint] startup cleanup failed:", err.message);
});

// Load i18n.
loadLocale(engine.getLocale?.() || engine.config?.locale);

// Startup token prevents unrelated local processes from calling private APIs.
const SERVER_TOKEN = process.env.CODIA_TOKEN || crypto.randomBytes(16).toString("hex");
const pwaAuth = createPwaAuth({ secret: SERVER_TOKEN });
const serverAuthService = createServerAuthService({
  codiaHome,
  loopbackToken: SERVER_TOKEN,
  runtimeContext: () => engine.getRuntimeContext(),
});
const webSocketTicketService = createWebSocketTicketService();

// Create the Hono application.
const app = new Hono<ServerRuntimeContext>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// CORS defaults to localhost. CODIA_CORS_ORIGIN can expand access.
const corsAllowedOrigin = process.env.CODIA_CORS_ORIGIN;
function getWebAccessKey() {
  return engine.preferences?.getWebAccess?.()?.api_key || "";
}

function pwaPathRequiresModelLock(pathname) {
  return pathname === "/api/models/set"
    || pathname === "/api/models/switch"
    || pathname === "/api/preferences/models"
    || pathname === "/api/providers/fetch-models"
    || pathname === "/api/providers/test"
    || pathname === "/api/auth/oauth/start"
    || pathname === "/api/auth/oauth/callback"
    || pathname === "/api/auth/oauth/logout"
    || /^\/api\/providers\/[^/]+\/models\/[^/]+$/.test(pathname)
    || /^\/api\/auth\/oauth\/[^/]+\/custom-models(?:\/[^/]+)?$/.test(pathname);
}

function isPublicAccessInfoRequest(c) {
  const url = new URL(c.req.url);
  return c.req.method === "GET" && url.pathname === "/";
}

function isResourceTicketContentRequest(c, url) {
  return (c.req.method === "GET" || c.req.method === "HEAD")
    && /^\/api\/resources\/[^/]+\/content$/.test(url.pathname)
    && !!url.searchParams.get("ticket");
}

function isPluginIframeTicketRequest(c, url) {
  return (c.req.method === "GET" || c.req.method === "HEAD")
    && /^\/api\/plugins\/[^/]+\/.+$/.test(url.pathname)
    && !!url.searchParams.get("pluginIframeTicket");
}

function isPluginAssetSessionRequest(c, url) {
  return (c.req.method === "GET" || c.req.method === "HEAD")
    && isPluginAssetRequest(url.pathname);
}

function createWebAccessPrincipal(connectionKind = "lan") {
  const runtimeContext = typeof engine.getRuntimeContext === "function" ? engine.getRuntimeContext() : {};
  return normalizePrincipal({
    kind: "account_user",
    credentialKind: "service_token",
    connectionKind,
    trustState: connectionKind === "custom_remote" ? "tunnel" : connectionKind,
    serverId: runtimeContext?.serverId ?? null,
    serverNodeId: runtimeContext?.serverNodeId ?? runtimeContext?.serverId ?? null,
    userId: runtimeContext?.userId ?? null,
    studioId: runtimeContext?.studioId ?? null,
    scopes: ["chat", "resources", "tools"],
  });
}

function authenticateLegacyAccessToken(token, connectionKind) {
  if (!token) return null;
  const pwaSession = pwaAuth.getSession(token);
  if (pwaSession) {
    return {
      principal: normalizePrincipal({
        kind: "account_user",
        credentialKind: "user_session",
        connectionKind,
        trustState: connectionKind === "custom_remote" ? "tunnel" : connectionKind,
        userId: pwaSession.userId,
        scopes: ["chat", "resources.read", "files.read", "files.write"],
      }),
      pwaSession,
    };
  }
  if (token === getWebAccessKey()) {
    return { principal: createWebAccessPrincipal(connectionKind), pwaSession: null };
  }
  return null;
}

function renderAccessInfoPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>本机 API 服务</title>
  <style>
    body { font: 14px/1.7 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 40px; color: #172323; background: #f3f7f7; }
    code { color: #086d69; background: #e5efee; border-radius: 3px; padding: 2px 6px; }
    .card { max-width: 760px; margin: 0 auto; border: 1px solid #d2dfde; border-radius: 6px; padding: 24px 26px; background: #fff; box-shadow: 0 10px 28px rgba(17, 47, 46, .07); }
    h1 { margin: 0 0 12px; color: #0a817c; font-size: 24px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>本机 API 服务</h1>
    <p>此服务需要访问密钥。打开根地址只会显示本帮助页，并不表示 API 异常。</p>
    <p>请在桌面端的<strong>设置 &gt; 共享 &gt; Web 访问 API Key</strong>中生成密钥，然后调用：</p>
    <p><code>GET /api/health</code></p>
    <p>请求头请使用 <code>Authorization: Bearer &lt;api_key&gt;</code> 或 <code>X-API-Key: &lt;api_key&gt;</code>。</p>
    <p>URL 查询参数中的 token 仅供本机回环连接使用，不应作为 HTTP API 凭据。</p>
  </main>
</body>
</html>`;
}
app.use("*", createCorsMiddleware(corsAllowedOrigin));
app.use("*", async (c, next) => {
  if (isPublicAccessInfoRequest(c)) {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.html(renderAccessInfoPage());
  }

  const url = new URL(c.req.url);
  const transport = inferHttpConnectionKind({
    hostHeader: c.req.header("host"),
    remoteAddress: c.env?.incoming?.socket?.remoteAddress,
    networkMode: accessRuntimeState.mode,
  });
  if (!transport.connectionKind) {
    return c.json({ error: "invalid_transport", detail: transport.reason }, 403);
  }
  c.set("transportConnectionKind", transport.connectionKind);

  if (isResourceTicketContentRequest(c, url)) {
    await next();
    return;
  }
  if (isPluginIframeTicketRequest(c, url)) {
    try {
      verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket: true });
    } catch (err) {
      if (err instanceof PluginIframeTicketError) {
        return c.json({ error: err.code, detail: err.message }, err.status);
      }
      throw err;
    }
    await next();
    return;
  }
  if (isMalformedPluginAssetRequest(c.req.url, url.pathname)) {
    return c.json({ error: "plugin_asset_not_found" }, 404);
  }
  if (isPluginAssetSessionRequest(c, url)) {
    try {
      const session = verifyPluginAssetSessionForHostRequest(c, engine, { requireSession: false });
      if (session) {
        await next();
        return;
      }
    } catch (err) {
      if (err instanceof PluginAssetSessionError) {
        return c.json({ error: err.code, detail: err.message }, err.status);
      }
      throw err;
    }
  }
  if (isPublicHttpRoute({ method: c.req.method, path: url.pathname })) {
    await next();
    return;
  }

  const allowLocalQueryToken = transport.connectionKind === "local";
  const token = extractAccessTokenFromHono(c);
  const authResult = serverAuthService.authenticateRequestDetailed({
    authorization: c.req.header("authorization"),
    queryToken: allowLocalQueryToken ? c.req.query("token") : null,
    cookieHeader: c.req.header("cookie"),
    allowQueryToken: allowLocalQueryToken,
    connectionKind: transport.connectionKind,
  });
  let authPrincipal: AuthPrincipalValue = authResult.principal;
  let pwaSession = null;
  if (!authPrincipal) {
    const legacy = authenticateLegacyAccessToken(token, transport.connectionKind);
    authPrincipal = legacy?.principal || null;
    pwaSession = legacy?.pwaSession || null;
  }
  const resolvedPrincipal = resolveHttpRequestPrincipal(c, engine, {
    serverAuthService,
    connectionKind: transport.connectionKind,
    wsTicketService: webSocketTicketService,
    legacyPrincipal: authPrincipal as any,
  });
  if (!resolvedPrincipal.ok) {
    return c.json(resolvedPrincipal.body, resolvedPrincipal.status);
  }
  authPrincipal = resolvedPrincipal.principal as AuthPrincipalValue;

  if (pwaSession) {
    c.set("pwaSession", pwaSession);
    if (["POST", "PUT", "DELETE"].includes(c.req.method) && pwaPathRequiresModelLock(url.pathname)) {
      return c.json({ error: "pwa_model_locked" }, 403);
    }
  }
  c.set("authPrincipal", authPrincipal);

  await next();
});

//
app.onError((err, c) => {
  const appErr = AppError.wrap(err);
  errorBus.report(appErr, {
    context: { method: c.req.method, url: c.req.url },
  });
  return c.json(
    { error: { code: appErr.code, message: appErr.message, traceId: appErr.traceId } },
    appErr.httpStatus
  );
});

//
const confirmStore = new ConfirmStore({ persistPath: path.join(codiaHome, "approvals.json") });
engine.setConfirmStore(confirmStore);

// --- Deferred Result Store ---
const deferredResultStore = new DeferredResultStore(
  hub.eventBus,
  path.join(codiaHome, ".ephemeral", "deferred-tasks.json"),
  { getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setDeferredResultStore(deferredResultStore);

const subagentRunStore = new SubagentRunStore(
  path.join(codiaHome, "subagent-runs.json"),
  { getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setSubagentRunStore(subagentRunStore);

const subagentThreadStore = new SubagentThreadStore(
  path.join(codiaHome, "subagent-threads.json"),
  { getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setSubagentThreadStore(subagentThreadStore);

const WORKFLOW_ACTIVITY_TTL_MS = 72 * 60 * 60 * 1000;
const workflowActivityStore = new WorkflowActivityStore(
  path.join(codiaHome, "workflow-activity.json"),
);
workflowActivityStore.prune(WORKFLOW_ACTIVITY_TTL_MS, Date.now());
const activityHub = new ActivityHub(
  { emit: (event, sessionPath) => engine.emitEvent(event, sessionPath) },
  workflowActivityStore,
  { getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setActivityHub(activityHub);

// Bus handlers for plugin access
registerDeferredResultBusHandlers(hub.eventBus, deferredResultStore);

registerTaskRegistryBusHandlers(hub.eventBus, engine.taskRegistry);
hub.eventBus.handle("session:get-titles", async ({ paths }) => {
  if (!Array.isArray(paths) || !paths.length) return { titles: {} };
  const coord = engine._sessionCoord;
  if (!coord?.getTitlesForPaths) return { titles: {} };
  const titles = await coord.getTitlesForPaths(paths);
  return { titles };
});
hub.eventBus.handle("usage:list", (filter = {}) => {
  return engine.usageLedger.list(filter);
});
hub.eventBus.handle("utility:call-text", async (payload: UtilityCallTextPayload = {}) => {
  const sessionPath = typeof payload.sessionPath === "string" && payload.sessionPath.trim()
    ? payload.sessionPath.trim()
    : null;
  const agentId = typeof payload.agentId === "string" && payload.agentId.trim()
    ? payload.agentId.trim()
    : (sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null);
  const utility = engine.resolveUtilityConfig({ agentId, sessionPath });
  const text = await callText({
    api: utility.api,
    apiKey: utility.api_key,
    baseUrl: utility.base_url,
    model: utility.utility,
    headers: utility.utility?.headers || {},
    systemPrompt: payload.systemPrompt || "",
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    timeoutMs: typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
      ? Math.max(1_000, Math.min(120_000, payload.timeoutMs))
      : undefined,
    callPurpose: payload.operation || "utility_call_text",
    signal: payload.signal instanceof AbortSignal ? payload.signal : null,
    usageLedger: utility.usageLedger,
    usageContext: {
      source: {
        subsystem: "utility",
        operation: payload.operation || "call-text",
        surface: sessionPath ? "desktop" : "system",
        trigger: "tool",
      },
      attribution: sessionPath
        ? { kind: "session", agentId: utility.usageAgentId || agentId || null, sessionPath }
        : { kind: "utility", agentId: utility.usageAgentId || agentId || null },
    },
  });
  return { text };
});

// Register Pi SDK extension factory
await engine.registerExtensionFactory(createDeferredResultExtension(deferredResultStore));

//
const { BridgeManager } = await import("../lib/bridge/bridge-manager.ts");
const bridgeManager = new BridgeManager({ engine, hub });
hub.bridgeManager = bridgeManager;
async function startBridgeManager({ autoStart = false } = {}) {
  if (autoStart) bridgeManager.autoStart(engine.agents);
  return bridgeManager;
}
const runtimeDiagnostics = createRuntimeDiagnosticsService({
  appName: "Codia",
  traceStore: engine.getRuntimeTraceStore?.(),
});

const shouldCreateStartupSession = process.env.CODIA_CREATE_STARTUP_SESSION !== "0"
  && process.env.CODIA_CREATE_STARTUP_SESSION !== "0";
// ③ 跳过启动期 session 创建时，服务就绪不等待聊天会话预热。
if (shouldCreateStartupSession && engine.currentModel) {
  console.log("[server] creating default session after plugins/extensions init...");
  await engine.createSession(null, null, true, null);
  console.log("[server] default session created");
  dlog.log("server", `session created, model=${engine.currentModel.name}`);
} else if (!shouldCreateStartupSession) {
  console.log("[server] startup session creation skipped");
  dlog.log("server", "startup session creation skipped");
} else {
  const availableCount = engine.availableModels?.length ?? 0;
  const chatRef = engine.agent?.config?.models?.chat;
  const chatRefStr = typeof chatRef === "object" ? JSON.stringify(chatRef) : (chatRef || "(empty)");
  let reason;
  if (availableCount === 0) {
    reason = "available models list is empty (no provider has valid api_key + models)";
  } else if (!chatRef) {
    reason = `agent.config.models.chat is empty, but ${availableCount} models are available`;
  } else {
    reason = `models.chat=${chatRefStr} not found in ${availableCount} available models`;
  }
  console.warn(`[server] no available model, skipping default session creation: ${reason}`);
  dlog.warn("server", `session creation skipped: ${reason}`);
}

const { restRoute: chatRestRoute, wsRoute: chatWsRoute } = createChatRoute(engine, hub, { upgradeWebSocket, runtimeDiagnostics });
app.route("/api", chatRestRoute);
app.route("", chatWsRoute);
app.route("/api", createSessionsRoute(engine));
app.route("/api", createSessionProjectsRoute(engine));
app.route("/api", createStudioWorkspacesRoute(engine));
app.route("/api", createModelsRoute(engine));
// Static memory maintenance endpoints must precede /memories/:id.
app.route("/api", createUsageMaintenanceRoute(engine));
app.route("/api", createConfigRoute(engine));
app.route("/api", createUploadRoute(engine));
app.route("/api", createResourcesRoute(engine));
app.route("/api", createCardsRoute(engine));
app.route("/api", createProvidersRoute(engine));
app.route("/api", createAvatarRoute(engine));
app.route("/api", createAgentsRoute(engine));
app.route("/api", createDeskRoute(engine, hub));
app.route("/api", createSkillsRoute(engine));
app.route("/api", createCharacterCardsRoute(engine));
app.route("/api", createChannelsRoute(engine, hub));
app.route("/api", createDmRoute(engine, hub));
app.route("/api", createFsRoute(engine));
app.route("/api", createPreferencesRoute(engine));
app.route("/api", createSettingsSnapshotRoute(engine as any, {
  bridgeManagerRef: bridgeManager as any,
  runtimeState: accessRuntimeState,
}));
app.route("/api", createExperimentsRoute(engine));
app.route("/api", createBridgeRoute(engine, bridgeManager));
app.route("/api", createWukongRoute(engine));
app.route("/api", createAuthRoute(engine));
app.route("/api", createDiaryRoute(engine));
app.route("/api", createConfirmRoute(confirmStore, engine));
app.route("/api", createTaskConsoleRoute(engine, confirmStore));
app.route("/api", createTaskArtifactsRoute(engine));
app.route("/api", createToolActionsRoute(engine));
app.route("/api", createWorkflowRecoveryRoute(engine));
app.route("/api", createModelQualificationRoute(engine));
app.route("/api", createPluginsRoute(engine));
app.route("/api", createCheckpointsRoute(engine));
app.route("/api", createCommandsRoute(engine));
app.route("/api", createPromptsRoute(engine));
app.route("/api", createWebSocketAuthRoute({
  ticketService: webSocketTicketService,
}));
app.route("/api", createServerIdentityRoute({
  codiaHome: engine.codiaHome || codiaHome,
  appVersion,
  getRuntimeContext: () => engine.getRuntimeContext(),
}));
app.route("/api", createSystemHealthRoute(engine, {
  bridgeManager,
  projectRoot: fromRoot("."),
}));
app.route("/api", createRuntimeDiagnosticsRoute(runtimeDiagnostics));
app.route("/api", createVoiceRoute(engine));
app.route("/api", createSpeechRecognitionRoute(engine));
app.route("/api", createMediaRoute(engine, hub));
app.route("/api", createResourceIoRoute(engine));
app.route("/api", createAccessRoute({ engine, runtimeState: accessRuntimeState }));
app.route("/api", createDevicesRoute(engine));
app.route("/api", createMobileWorkbenchRoute(engine));
app.route("/api", createWebAuthRoute({
  codiaHome: engine.codiaHome || codiaHome,
  authService: serverAuthService,
  getConnectionKind: (c) => c.get("transportConnectionKind"),
  getRuntimeContext: () => engine.getRuntimeContext(),
  secureCookies: accessRuntimeState.mode === "custom_remote",
}));
app.route("/api", createUsageRoute(engine));
app.route("/api", createWorkspaceToolsRoute({
  eventBus: hub.eventBus,
  listAgents: () => engine.listAgents?.() || [],
}));
app.route("/api", pwaAuth.route);
app.route("", createHtmlPreviewRoute());
app.route("", createMobileStaticRoute({ distDir: path.join(fromRoot("desktop"), "dist-renderer") }));
//

//
app.get("/api/health", async (c) => {
  // Report whether custom avatars exist without requiring HEAD probes.
  const avatars = {};
  for (const role of ['agent', 'user']) {
    const dir = path.join(role === 'user' ? engine.userDir : engine.agentDir, 'avatars');
    avatars[role] = false;
    try {
      const files = fs.readdirSync(dir);
      avatars[role] = files.some(f => /\.(png|jpe?g|webp)$/i.test(f));
    } catch {
      // Ignore desktop log payloads that are not valid JSON.
    }
  }
  return c.json({
    status: "ok",
    version: appVersion,
    agentId: engine.currentAgentId || null,
    agent: engine.agentName,
    agentYuan: engine.agent?.config?.agent?.yuan || "codia",
    user: engine.userName,
    model: engine.currentModel?.name,
    avatars,
  });
});

//
app.post("/api/log", async (c) => {
  const { level, module, message } = await safeJson(c);
  if (!message) return c.json({ ok: false });
  const safeModule = redactLogLabel(module || "desktop");
  const safeMessage = redactLogText(message);
  if (level === "error") dlog.error(safeModule, safeMessage);
  else if (level === "warn") dlog.warn(safeModule, safeMessage);
  else dlog.log(safeModule, safeMessage);
  return c.json({ ok: true });
});

//
app.get("/api/plan-mode", async (c) => {
  return c.json({
    enabled: engine.planMode,
    planMode: engine.planMode,
    mode: engine.permissionMode,
    permissionMode: engine.permissionMode,
    accessMode: engine.accessMode,
    locked: false,
  });
});
app.post("/api/plan-mode", async (c) => {
  const { enabled, mode, permissionMode, accessMode } = await safeJson(c);
  const nextMode = permissionMode || mode || accessMode;
  const result = nextMode ? engine.setSessionPermissionMode(nextMode) : engine.setPlanMode(!!enabled);
  return c.json({
    ok: result?.ok !== false,
    locked: false,
    enabled: engine.planMode,
    planMode: engine.planMode,
    mode: engine.permissionMode,
    permissionMode: engine.permissionMode,
    accessMode: engine.accessMode,
  });
});

app.get("/api/session-permission-mode", async (c) => {
  return c.json({
    mode: engine.permissionMode,
    permissionMode: engine.permissionMode,
    accessMode: engine.accessMode,
    defaultMode: engine.getSessionPermissionModeDefault(),
  });
});

app.get("/api/session-thinking-level", async (c) => {
  const sessionPath = c.req.query("sessionPath") || c.req.query("path") || null;
  const pendingNewSession = c.req.query("pendingNewSession") === "1"
    || c.req.query("pendingNewSession") === "true"
    || !sessionPath;
  return c.json(resolveSessionThinkingLevelState(engine, { sessionPath, pendingNewSession }));
});

app.post("/api/session-thinking-level", async (c) => {
  const { sessionPath, level } = await safeJson(c);
  const result = sessionPath
    ? await engine.setSessionThinkingLevel(sessionPath, level)
    : await engine.setDefaultThinkingLevel?.(level);
  if (result?.ok === false) {
    return c.json({
      ok: false,
      error: result.error || "failed to set thinking level",
      ...resolveSessionThinkingLevelState(engine, { sessionPath, pendingNewSession: !sessionPath }),
    }, 409);
  }
  return c.json({
    ok: true,
    ...resolveSessionThinkingLevelState(engine, { sessionPath, pendingNewSession: !sessionPath }),
  });
});

app.post("/api/session-permission-mode", async (c) => {
  const { mode, permissionMode, accessMode, pendingNewSession, currentSessionOnly, sessionPath } = await safeJson(c);
  const requestedMode = permissionMode || mode || accessMode;
  const targetSessionPath = typeof sessionPath === "string" && sessionPath ? sessionPath : null;
  const result = currentSessionOnly === true
    ? engine.setCurrentSessionPermissionMode(requestedMode)
    : pendingNewSession === true
    ? engine.setPendingSessionPermissionMode(requestedMode)
    : targetSessionPath
    ? engine.setSessionPermissionModeForSession(targetSessionPath, requestedMode)
    : engine.setSessionPermissionMode(requestedMode);
  const explicitSession = currentSessionOnly === true || !!targetSessionPath;
  if (explicitSession && result?.ok === false) {
    const failedMode = result.mode || engine.permissionMode;
    return c.json({
      ok: false,
      error: result.error || "session permission mode requires an active session",
      mode: failedMode,
      permissionMode: failedMode,
      accessMode: failedMode === "read_only" ? "read_only" : "operate",
      defaultMode: engine.getSessionPermissionModeDefault(),
    }, 409);
  }
  const scopedMode = pendingNewSession === true || explicitSession;
  const effectiveMode = scopedMode ? result?.mode : engine.permissionMode;
  return c.json({
    ok: result?.ok !== false,
    mode: effectiveMode,
    permissionMode: effectiveMode,
    accessMode: scopedMode
      ? (effectiveMode === "read_only" ? "read_only" : "operate")
      : engine.accessMode,
    defaultMode: engine.getSessionPermissionModeDefault(),
  });
});

// Remote shutdown used by the desktop shell.
app.post("/api/shutdown", async (c) => {
  console.log("[server] received HTTP shutdown request; cleaning up...");
  //
  setTimeout(() => gracefulShutdown(), 100);
  return c.json({ ok: true });
});

activeFetch = app.fetch.bind(app);

try {
  // Internal browser control WS (raw ws).
  // WsTransport requires raw ws .on()/.off() event methods that Hono's WSContext
  // doesn't expose, so we handle /internal/browser via a standalone WebSocketServer.
  //
  // To avoid both handlers firing on the same upgrade request (which would corrupt
  // the socket), we pass injectWebSocket a proxy that filters out /internal/browser
  // upgrades before they reach Hono's handler.
  const browserWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/internal/browser") return; // let Hono handle it

    const transport = inferHttpConnectionKind({
      hostHeader: req.headers.host,
      remoteAddress: req.socket?.remoteAddress,
      networkMode: accessRuntimeState.mode,
    });
    if (!transport.connectionKind) {
      socket.destroy();
      return;
    }

    const allowLocalQueryToken = transport.connectionKind === "local";
    const token = extractAccessTokenFromNodeRequest(req, { allowQuery: allowLocalQueryToken });
    const authPrincipal = serverAuthService.authenticateRequest({
      authorization: req.headers.authorization,
      queryToken: allowLocalQueryToken ? url.searchParams.get("token") : null,
      cookieHeader: req.headers.cookie,
      allowQueryToken: allowLocalQueryToken,
      connectionKind: transport.connectionKind,
    }) || authenticateLegacyAccessToken(token, transport.connectionKind)?.principal;
    const authz = authPrincipal
      ? authorizeHttpRoute({ method: "GET", path: url.pathname, principal: authPrincipal })
      : null;
    if (!authPrincipal || !authz?.allowed) {
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserWss.emit("connection", ws, req);
    });
  });

  browserWss.on("connection", (ws) => {
    const bm = BrowserManager.instance();
    bm.setWsTransport(ws);

    // Optional browser WS trace; disabled unless CODIA_DEBUG=1.
    const _bwsEnabled = process.env.CODIA_DEBUG === "1";
    let _bwsBuf = "";
    let _bwsFlushTimer = null;
    const _bwsLogPath = path.join(codiaHome, "browser-ws.log");
    let _bwsFlushChain = Promise.resolve();
    const _bwsFlush = () => {
      if (!_bwsBuf) return;
      const chunk = _bwsBuf;
      _bwsBuf = "";
      _bwsFlushTimer = null;
      _bwsFlushChain = _bwsFlushChain.then(() =>
        fs.promises.appendFile(_bwsLogPath, chunk)
      ).catch(() => {});
    };
    const _bwsLog = (line) => {
      if (!_bwsEnabled) return;
      _bwsBuf += `${new Date().toISOString()} ${line}\n`;
      if (!_bwsFlushTimer) _bwsFlushTimer = setTimeout(_bwsFlush, 500);
    };
    _bwsLog("browser WS connected");
    const origSend = ws.send.bind(ws);
    ws.send = function(data, ...args) {
      try { const m = JSON.parse(data); _bwsLog(`-> cmd=${m.cmd || m.type} id=${m.id || "?"}`); } catch {
        // Ignore non-JSON browser control frames in verbose logging.
      }
      return origSend(data, ...args);
    };
    ws.on("message", (data) => {
      try { const m = JSON.parse(data); _bwsLog(`<- type=${m.type} id=${m.id || "?"} error=${m.error || "none"}`); } catch {
        // Ignore non-JSON browser control frames in verbose logging.
      }
    });

    ws.on("close", () => {
      if (bm._transport?._ws === ws) bm.setWsTransport(null);
      console.log("[server] Electron browser control WS disconnected");
    });
    ws.on("error", (err) => {
      console.error("[server] Electron browser control WS error:", err.message);
      if (bm._transport?._ws === ws) bm.setWsTransport(null);
    });
    console.log("[server] Electron browser control WS connected");
  });

  // Inject Hono WS for chat and other WS routes, but skip /internal/browser
  // to prevent double-handling the same upgrade request
  injectWebSocket({
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "upgrade") {
        return server.on("upgrade", (req, socket, head) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (url.pathname === "/internal/browser") return; // already handled above
          handler(req, socket, head);
        });
      }
      return (server as unknown as { on: (event: string, handler: (...args: unknown[]) => void) => ServerType }).on(event, handler);
    },
  } as Parameters<typeof injectWebSocket>[0]);

  const address = server.address();
  const actualPort = typeof address === "string" || !address ? port : (address as AddressInfo).port;
  accessRuntimeState.actualPort = actualPort;

  console.log(`[server] local service running at http://${host}:${actualPort}`);
  dlog.log("server", `listening on ${host}:${actualPort}`);

 //
  try {
    const runtimeIdentity = engine.getRuntimeContext?.() || {};
    fs.writeFileSync(serverInfoPath, JSON.stringify({
      pid: process.pid,
      port: actualPort,
      token: SERVER_TOKEN,
      version: appVersion,
      scope: serverInfoScope,
      studioId: runtimeIdentity.studioId || null,
      serverId: runtimeIdentity.serverId || null,
      ownerKind: process.env.CODIA_SERVER_OWNER === "desktop" ? "desktop" : "standalone",
      ownerPid: Number(process.env.CODIA_SERVER_OWNER_PID) || null,
    }), { mode: 0o600 });
    try { fs.chmodSync(serverInfoPath, 0o600); } catch {
      // Some filesystems ignore mode-on-create for existing files.
    }
  } catch (e) {
    console.error(`[server] failed to write ${path.basename(serverInfoPath)}:`, e.message);
  }

  // Auto-start configured external platforms.
  await startBridgeManager({ autoStart: true });
  dlog.log("server", "bridge autoStart done");
  console.log(`[server] ready: port=${actualPort}`);

  // In standalone TTY mode, enter the CLI.
  if (process.stdin.isTTY) {
    startCLI({
      port: actualPort,
      token: SERVER_TOKEN,
      agentName: engine.agentName,
      userName: engine.userName,
    });
  }

} catch (err) {
  console.error("[server] startup failed:", err.message);
  process.exit(1);
}

// Graceful shutdown with a concurrency guard and timeout.
let _shutting = false;
async function gracefulShutdown() {
  if (_shutting) return;
  _shutting = true;
  console.log("\n[server] shutting down...");
  dlog.log("server", "shutting down...");

  // Force exit if shutdown work hangs.
  const forceTimer = setTimeout(() => {
    console.error("[server] shutdown timed out; forcing exit");
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  try {
    // 1. Stop accepting new requests.
    server.close();
    console.log("[server] HTTP server closed");
    dlog.log("server", "HTTP server closed");

    // 2. Suspend browsers so sessions can be restored on restart.
    try {
      const { BrowserManager } = await import("../lib/browser/browser-manager.ts");
      const bm = BrowserManager.instance();
      for (const sp of bm.runningSessions) {
        await bm.suspendForSession(sp);
        console.log(`[server] browser suspended: ${sp}`);
      }
    } catch (e) {
      console.error("[server] browser suspend failed:", e.message);
    }

    // 3. Stop external platforms.
    await bridgeManager.stopAll();
    dlog.log("server", "bridge stopped");

    // 4. Flush deferred result store.
    engine.deferredResults?.dispose?.();

    // 5. Dispose Hub and engine resources.
    await hub.dispose();
    console.log("[server] Hub + Engine disposed");
    dlog.log("server", "hub + engine disposed");
  } catch (err) {
    console.error("[server] 关闭出错:", err.message);
    dlog.error("server", `shutdown error: ${err.message}`);
  }

  clearTimeout(forceTimer);
  try { fs.unlinkSync(serverInfoPath); } catch {
    // Ignore stale/missing server-info during shutdown.
  }
  process.exit(0);
}

const PROCESS_SIGNAL_HANDLER_GUARD = Symbol.for("codia.server.process-signal-handlers-registered");
const PROCESS_ERROR_HANDLER_GUARD = Symbol.for("codia.server.process-error-handlers-registered");
if (!process[PROCESS_SIGNAL_HANDLER_GUARD]) {
  process[PROCESS_SIGNAL_HANDLER_GUARD] = true;
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
  if (process.platform === "win32") process.on("SIGBREAK", gracefulShutdown);
}

// Global unhandled error guard.
let _stdoutBroken = false;
function _safeConsoleError(...args) {
  if (_stdoutBroken) return;
  try {
    console.error(...args);
  } catch {
    // stdout/stderr may already be closed during shutdown.
    _stdoutBroken = true;
  }
}

if (!process[PROCESS_ERROR_HANDLER_GUARD]) {
  process[PROCESS_ERROR_HANDLER_GUARD] = true;
  process.on("uncaughtException", (err) => {
    const code = getErrorCode(err);
    if (code === "EPIPE" || code === "ERR_IPC_CHANNEL_CLOSED") {
      if (!_stdoutBroken) {
        _stdoutBroken = true;
        dlog.error("server", `stdout pipe broken (${code}), suppressing further console output`);
      }
      return;
    }
    dlog.error("server", `uncaughtException: ${err.message}`);
    _safeConsoleError("[server] uncaughtException:", err);
  });
  process.on("unhandledRejection", (reason) => {
    dlog.error("server", `unhandledRejection: ${reason}`);
    _safeConsoleError("[server] unhandledRejection:", reason);
  });
}
