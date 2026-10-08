import { hasStudioOwnerScope } from "../../shared/access-scope-profiles.ts";

const AUTHENTICATED_ONLY = Object.freeze({ kind: "authenticated" });
const LOCAL_ONLY = Object.freeze({ kind: "local_only" });
const PUBLIC = Object.freeze({ kind: "public" });
const STUDIO_OWNER = Object.freeze({ kind: "studio_owner" });

type Principal = {
  kind?: string;
  connectionKind?: string;
  credentialKind?: string;
  scopes?: unknown;
} | null | undefined;

type RoutePolicy = Readonly<{
  kind: string;
  scope?: string;
}>;

type RouteAllowedResult = {
  allowed: true;
  policy: RoutePolicy;
};

type RouteDeniedResult = {
  allowed: false;
  policy: RoutePolicy;
  error?: string;
  status: 403;
  reason?: string;
  requiredScope?: string;
};

type RouteAuthorizationResult = RouteAllowedResult | RouteDeniedResult;

export function authorizeHttpRoute({
  method,
  path,
  principal,
}: { method?: unknown; path?: unknown; principal?: Principal }): RouteAuthorizationResult {
  const policy = classifyHttpRoute({ method, path });
  if (policy.kind === "public") {
    return allowed(policy);
  }
  if (isLocalOwnerPrincipal(principal)) {
    return allowed(policy);
  }
  if (isPluginRoutePrincipalAllowed(policy, path, principal)) {
    return allowed(policy);
  }
  if (policy.kind === "local_only") {
    return denied("local_only_route", 403, policy, {
      reason: "local_owner_required",
    });
  }
  if (policy.kind === "authenticated") {
    return principal ? allowed(policy) : denied("forbidden", 403, policy, {
      reason: "missing_principal",
    });
  }
  if (!principal) {
    return denied("forbidden", 403, policy, {
      reason: "missing_principal",
    });
  }
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  if (policy.kind === "studio_owner") {
    return isStudioOwnerPrincipal(principal)
      ? allowed(policy)
      : denied("studio_owner_required", 403, policy, {
        reason: "studio_owner_required",
      });
  }
  const required = policy.scope;
  if (scopeAllows(scopes, required)) {
    return allowed(policy);
  }
  return denied("insufficient_scope", 403, policy, {
    reason: "missing_required_scope",
    requiredScope: required,
  });
}

export function classifyHttpRoute({ method = "GET", path = "" }: { method?: unknown; path?: unknown } = {}): RoutePolicy {
  const verb = String(method || "GET").toUpperCase();
  const routePath = normalizePath(path);

  if (isOcrRuntimeRoute(verb, routePath)) return PUBLIC;
  if (isMobileStaticRoute(verb, routePath)) return PUBLIC;
  if (isWebAuthBootstrapRoute(verb, routePath)) return PUBLIC;
  if (isMcpOAuthCallbackRoute(verb, routePath)) return PUBLIC;
  if (isHtmlPreviewDocumentRoute(verb, routePath)) return PUBLIC;

  if (routePath === "/" && verb === "GET") return PUBLIC;
  if (routePath === "/api/health") return AUTHENTICATED_ONLY;
  if (routePath === "/api/server/identity") return AUTHENTICATED_ONLY;
  if (isClientLocalOnlyRoute(verb, routePath)) return LOCAL_ONLY;

  if (routePath === "/ws") return scoped("chat");
  if (routePath === "/internal/browser") return LOCAL_ONLY;
  if (routePath === "/api/mobile/bootstrap") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (isAvatarReadRoute(verb, routePath)) return scoped("chat");
  if (isAvatarWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isAvatarRoutePath(routePath)) return LOCAL_ONLY;
  if (isWorkbenchFileReadRoute(verb, routePath)) return scoped("files.read");
  if (isWorkbenchFileWriteRoute(verb, routePath)) return scoped("files.write");
  if (isStudioWorkspaceReadRoute(verb, routePath)) return scoped("files.read");
  if (isStudioWorkspaceWriteRoute(verb, routePath)) return scoped("files.write");
  if (routePath === "/api/preferences/workspace-ui-state") {
    if (verb === "GET") return scoped("files.read");
    if (verb === "PUT") return scoped("files.write");
    return LOCAL_ONLY;
  }
  if (routePath === "/api/session-projects" || routePath.startsWith("/api/session-projects/")) {
    return scoped("chat");
  }
  if (routePath === "/api/preferences/sidebar-ui") {
    return (verb === "GET" || verb === "PUT") ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/preferences/session-permission-default") {
    return (verb === "GET" || verb === "PUT") ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/preview/html") {
    return verb === "POST" ? scoped("files.read") : LOCAL_ONLY;
  }
  if (isSkillReadRoute(verb, routePath)) return scoped("chat");
  if (routePath === "/api/prompts/optimize") {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (isDeskFileReadRoute(verb, routePath)) return scoped("files.read");
  if (isDeskFileWriteRoute(verb, routePath)) return scoped("files.write");
  if (isResourceIoReadRoute(verb, routePath)) return scoped("files.read");
  if (isResourceIoWriteRoute(verb, routePath)) return scoped("files.write");
  if (routePath === "/api/usage/llm") return verb === "GET" ? STUDIO_OWNER : LOCAL_ONLY;
  if (isSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isSkillSettingsReadRoute(verb, routePath, path)) return scoped("settings.read");
  if (isSkillSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isMcpSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isMcpSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isImageGenerationReadRoute(verb, routePath)) return scoped("settings.read");
  if (isImageGenerationWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isImageGenerationProviderManagementRoute(verb, routePath)) return scoped("providers.manage");
  if (isLegacyMediaGenerationRoute(verb, routePath)) return scoped("chat");
  if (isPluginSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isPluginSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isProviderManagementRoute(verb, routePath)) return scoped("providers.manage");
  if (isBridgeManagementRoute(verb, routePath)) return scoped("bridge.manage");
  if (routePath === "/api/wukong/capabilities") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/wukong/tasks/run") {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/wukong/runtime/tasks/run") {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (isPluginAssetReadRoute(verb, routePath)) return scoped("chat");
  if (isPluginUiReadRoute(verb, routePath)) return scoped("chat");
  if (isPluginChatActionRoute(verb, routePath)) return scoped("chat");
  if (verb === "POST" && routePath === "/api/plugins/iframe-ticket") return scoped("chat");
  if (verb === "POST" && /^\/api\/resources\/[^/]+\/ticket$/.test(routePath)) {
    return scoped("resources.read");
  }
  if (routePath.startsWith("/api/resources/")) {
    if (verb === "GET" || verb === "HEAD") return scoped("resources.read");
    return scoped("resources.write");
  }
  if (routePath === "/api/sessions" || routePath.startsWith("/api/sessions/")) {
    return scoped("chat");
  }
  if (routePath === "/api/models") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/models/auxiliary-vision") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/models/set" || routePath === "/api/models/switch") {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/session-permission-mode") {
    return (verb === "GET" || verb === "POST") ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/session-thinking-level") {
    return (verb === "GET" || verb === "POST") ? scoped("chat") : LOCAL_ONLY;
  }
  if (/^\/api\/confirm\/[^/]+$/.test(routePath)) {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/browser/session-states") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/upload-blob") {
    return verb === "POST" ? scoped("files.write") : LOCAL_ONLY;
  }
  if (routePath === "/api/chat" || routePath.startsWith("/api/chat/")) {
    return scoped("chat");
  }
  if (
    routePath === "/api/channels"
    || routePath.startsWith("/api/channels/")
    || routePath.startsWith("/api/conversations/")
    || routePath === "/api/dm"
    || routePath.startsWith("/api/dm/")
  ) {
    return scoped("chat");
  }

  if (routePath.startsWith("/api/")) return STUDIO_OWNER;

  return LOCAL_ONLY;
}

export function isPublicHttpRoute({ method = "GET", path = "" }: { method?: unknown; path?: unknown } = {}): boolean {
  return classifyHttpRoute({ method, path }).kind === "public";
}

export function isLocalOwnerPrincipal(principal: Principal): boolean {
  if (!principal || typeof principal !== "object") return false;
  return principal.kind === "local_user"
    && principal.connectionKind === "local"
    && principal.credentialKind === "loopback_token";
}

export function isStudioOwnerPrincipal(principal: Principal): boolean {
  if (isLocalOwnerPrincipal(principal)) return true;
  if (!principal || typeof principal !== "object") return false;
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  return hasStudioOwnerScope(scopes);
}

function scoped(scope: string): RoutePolicy {
  return Object.freeze({ kind: "scope", scope });
}

function isPluginRoutePrincipalAllowed(policy: RoutePolicy, path: unknown, principal: Principal): boolean {
  if (!principal || typeof principal !== "object") return false;
  if (principal.kind !== "plugin" || principal.credentialKind !== "plugin_surface_session") return false;
  if (policy.kind !== "scope" || policy.scope !== "chat") return false;
  const pluginId = typeof (principal as any).pluginId === "string" ? (principal as any).pluginId : "";
  if (!pluginId) return false;
  const routePath = normalizePath(path);
  const match = /^\/api\/plugins\/([^/]+)\/.+$/.exec(routePath);
  if (!match) return false;
  try {
    return decodeURIComponent(match[1]) === pluginId;
  } catch {
    return false;
  }
}

function allowed(policy: RoutePolicy): RouteAllowedResult {
  return { allowed: true, policy };
}

function denied(
  error: string,
  status: 403,
  policy: RoutePolicy,
  details: Partial<RouteDeniedResult> = {},
): RouteDeniedResult {
  return { allowed: false, error, status, policy, ...details };
}

function normalizePath(path: unknown): string {
  const raw = String(path || "");
  try {
    return new URL(raw, "http://gsap.local").pathname;
  } catch {
    return raw.split("?")[0] || "/";
  }
}

function isAvatarRoutePath(routePath: string): boolean {
  return routePath === "/api/avatar/agent"
    || routePath === "/api/avatar/user"
    || /^\/api\/agents\/[^/]+\/avatar$/.test(routePath);
}

function isAvatarReadRoute(verb: string, routePath: string): boolean {
  return (verb === "GET" || verb === "HEAD") && isAvatarRoutePath(routePath);
}

function isAvatarWriteRoute(verb: string, routePath: string): boolean {
  return (verb === "POST" || verb === "DELETE") && isAvatarRoutePath(routePath);
}

export function scopeAllows(scopes: string[], required?: string): boolean {
  if (!required) return true;
  if (scopes.includes(required)) return true;
  const [namespace] = required.split(".");
  return scopes.includes(namespace) || scopes.includes(`${namespace}.*`);
}

function isMobileStaticRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return isWebClientStaticRoute(routePath, "/mobile")
    || isWebClientStaticRoute(routePath, "/desktop");
}

function isWebClientStaticRoute(routePath: string, prefix: string): boolean {
  return routePath === prefix
    || routePath === `${prefix}/`
    || routePath === `${prefix}/index.html`
    || routePath === `${prefix}/styles.css`
    || routePath === `${prefix}/manifest.webmanifest`
    || routePath === `${prefix}/sw.js`
    || routePath === `${prefix}/icon.png`
    || routePath.startsWith(`${prefix}/assets/`)
    || routePath.startsWith(`${prefix}/lib/`)
    || routePath.startsWith(`${prefix}/themes/`)
    || routePath.startsWith(`${prefix}/locales/`)
    || routePath.startsWith(`${prefix}/icons/`);
}

function isOcrRuntimeRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath.startsWith("/ocr-runtime/");
}

function isHtmlPreviewDocumentRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return /^\/preview\/html\/[^/]+(?:\/assets\/[^/]+\/.+)?$/.test(routePath);
}

function isWebAuthBootstrapRoute(verb: string, routePath: string): boolean {
  if (routePath === "/api/web-auth/login") return verb === "POST";
  if (routePath === "/api/web-auth/session") return verb === "GET";
  if (routePath === "/api/web-auth/logout") return verb === "POST";
  if (routePath === "/api/pwa-auth/login") return verb === "POST";
  if (routePath === "/api/pwa-auth/status") return verb === "GET";
  return false;
}

function isMcpOAuthCallbackRoute(verb: string, routePath: string): boolean {
  return verb === "GET" && routePath === "/api/plugins/mcp/oauth/callback";
}

function isClientLocalOnlyRoute(verb: string, routePath: string): boolean {
  if (routePath === "/api/shutdown") return true;
  if (routePath.startsWith("/api/access/")) return true;
  if (routePath.startsWith("/api/devices/")) return true;
  if (routePath === "/api/skills/external-paths") return true;
  if (routePath === "/api/plugins/install") return true;
  if (routePath === "/api/plugins/dev" || routePath.startsWith("/api/plugins/dev/")) return true;
  if (routePath === "/api/preferences/computer-use/request-permissions") return true;
  if (routePath.startsWith("/api/plugins/image-gen/media/open/")) return true;
  if (routePath.startsWith("/api/media/generated/open/")) return true;
  if (/^\/api\/plugins\/[^/]+\/assets\/.+$/.test(routePath) && verb !== "GET" && verb !== "HEAD") {
    return true;
  }
  return false;
}

function isResourceIoReadRoute(verb: string, routePath: string): boolean {
  if (!routePath.startsWith("/api/resource-io/")) return false;
  if (verb === "GET" && (
    routePath === "/api/resource-io/watch-diagnostics"
    || routePath === "/api/resource-io/events"
  )) return true;
  if (verb === "POST" && (
    routePath === "/api/resource-io/subscribe"
    || routePath === "/api/resource-io/watch"
    || routePath === "/api/resource-io/stat"
    || routePath === "/api/resource-io/read"
    || routePath === "/api/resource-io/list"
    || routePath === "/api/resource-io/search"
  )) return true;
  if (verb === "DELETE" && (
    /^\/api\/resource-io\/subscriptions\/[^/]+$/.test(routePath)
    || /^\/api\/resource-io\/watch\/[^/]+$/.test(routePath)
  )) return true;
  return false;
}

function isResourceIoWriteRoute(verb: string, routePath: string): boolean {
  if (verb !== "POST") return false;
  return routePath === "/api/resource-io/write"
    || routePath === "/api/resource-io/write-expected-version"
    || routePath === "/api/resource-io/rename"
    || routePath === "/api/resource-io/move"
    || routePath === "/api/resource-io/trash";
}

function isSettingsReadRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET") return false;
  return routePath === "/api/config"
    || routePath === "/api/settings/snapshot"
    || routePath === "/api/plugins/settings"
    || routePath === "/api/plugins/settings-tabs"
    || routePath === "/api/providers/summary"
    || routePath === "/api/preferences/models"
    || routePath === "/api/preferences/appearance"
    || routePath === "/api/preferences/quick-chat"
    || routePath === "/api/preferences/notifications"
    || routePath === "/api/preferences/computer-use"
    || routePath === "/api/speech-recognition/providers"
    || routePath === "/api/experiments"
    || routePath === "/api/experiments/memory/cache-snapshot-reflection/observation"
    || routePath === "/api/bridge/status"
    || routePath === "/api/bridge/agently-mail/status"
    || routePath === "/api/agents"
    || routePath === "/api/user-profile"
    || routePath === "/api/memories"
    || routePath === "/api/memories/health"
    || routePath === "/api/memories/compiled"
    || routePath === "/api/memories/export"
    || /^\/api\/agents\/[^/]+\/config$/.test(routePath);
}

function isWorkbenchFileReadRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET" && verb !== "HEAD") return false;
  if (
    routePath === "/api/mobile/workbench/files"
    || routePath === "/api/mobile/workbench/search"
    || routePath === "/api/workbench/files"
    || routePath === "/api/workbench/search"
  ) {
    return verb === "GET";
  }
  return routePath === "/api/mobile/workbench/content"
    || routePath === "/api/workbench/content";
}

function isWorkbenchFileWriteRoute(verb: string, routePath: string): boolean {
  if (verb !== "POST") return false;
  return routePath === "/api/mobile/workbench/actions"
    || routePath === "/api/mobile/workbench/upload"
    || routePath === "/api/workbench/actions"
    || routePath === "/api/workbench/upload";
}

function isStudioWorkspaceReadRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath === "/api/studio/workspaces"
    || /^\/api\/studio\/workspaces\/[^/]+\/files$/.test(routePath);
}

function isStudioWorkspaceWriteRoute(verb: string, routePath: string): boolean {
  if (verb === "POST") return routePath === "/api/studio/workspaces";
  if (verb === "DELETE") return /^\/api\/studio\/workspaces\/[^/]+$/.test(routePath);
  return false;
}

function isDeskFileReadRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET") return false;
  return routePath === "/api/desk/path"
    || routePath === "/api/desk/files"
    || routePath === "/api/desk/search-files"
    || routePath === "/api/desk/skills"
    || routePath === "/api/desk/jian"
    || routePath === "/api/desk/beautify/status";
}

function isDeskFileWriteRoute(verb: string, routePath: string): boolean {
  if (verb !== "POST") return false;
  return routePath === "/api/desk/files"
    || routePath === "/api/desk/jian"
    || routePath === "/api/desk/beautify/cover"
    || routePath === "/api/desk/beautify/cover/apply"
    || routePath === "/api/desk/beautify/cover/preset/apply";
}

function isSettingsWriteRoute(verb, routePath) {
  if (verb === "POST" && routePath === "/api/preferences/setup-complete") return true;
  if (verb === "PATCH" && /^\/api\/experiments\/[^/]+$/.test(routePath)) return true;
  if (verb === "DELETE" && routePath === "/api/experiments/memory/cache-snapshot-reflection/observation") return true;
  return (verb === "PUT" && (
    routePath === "/api/config"
    || routePath === "/api/user-profile"
    || routePath === "/api/preferences/models"
    || routePath === "/api/preferences/appearance"
    || routePath === "/api/preferences/quick-chat"
    || routePath === "/api/preferences/notifications"
    || routePath === "/api/preferences/computer-use"
    || routePath === "/api/speech-recognition/config"
    || /^\/api\/agents\/[^/]+\/config$/.test(routePath)
  ))
    || (verb === "DELETE" && (
      routePath === "/api/memories"
      || routePath === "/api/memories/compiled"
    ))
    || (verb === "POST" && routePath === "/api/memories/import");
}

function isMcpSettingsReadRoute(verb: string, routePath: string): boolean {
  if (verb !== "GET") return false;
  return routePath === "/api/plugins/mcp/state"
    || /^\/api\/plugins\/mcp\/oauth\/poll\/[^/]+$/.test(routePath);
}

function isMcpSettingsWriteRoute(verb: string, routePath: string): boolean {
  if (verb === "PUT" && routePath === "/api/plugins/mcp/settings/enabled") return true;
  if (verb === "POST" && routePath === "/api/plugins/mcp/connectors") return true;
  if ((verb === "PUT" || verb === "DELETE") && /^\/api\/plugins\/mcp\/connectors\/[^/]+$/.test(routePath)) return true;
  if (verb === "POST" && /^\/api\/plugins\/mcp\/connectors\/[^/]+\/(?:start|stop|refresh-tools)$/.test(routePath)) return true;
  if (verb === "PUT" && /^\/api\/plugins\/mcp\/agents\/[^/]+\/connectors\/[^/]+$/.test(routePath)) return true;
  if (verb === "POST" && /^\/api\/plugins\/mcp\/connectors\/[^/]+\/oauth\/(?:start|logout)$/.test(routePath)) return true;
  return false;
}

function isSkillReadRoute(verb, routePath) {
  if (verb === "GET") {
    return routePath === "/api/skills";
  }
  return verb === "POST" && routePath === "/api/skills/translate";
}

function isSkillSettingsReadRoute(verb, routePath, rawPath) {
  if (verb !== "GET") return false;
  if (routePath === "/api/skills/bundles") return true;
  if (routePath !== "/api/skills") return false;
  return !hasQueryParam(rawPath, "runtime", "1");
}

function isSkillSettingsWriteRoute(verb, routePath) {
  return (verb === "PUT" && (
    /^\/api\/agents\/[^/]+\/skills$/.test(routePath)
    || routePath === "/api/skills/bundles/order"
    || /^\/api\/skills\/bundles\/[^/]+$/.test(routePath)
  ))
    || (verb === "PATCH" && (
      /^\/api\/agents\/[^/]+\/skills\/[^/]+$/.test(routePath)
      || /^\/api\/agents\/[^/]+\/skill-bundles\/[^/]+$/.test(routePath)
    ))
    || (verb === "POST" && (
      routePath === "/api/skills/install"
      || routePath === "/api/skills/bundles"
      || routePath === "/api/skills/reload"
      || /^\/api\/skills\/bundles\/[^/]+\/export$/.test(routePath)
    ))
    || (verb === "DELETE" && (
      /^\/api\/skills\/bundles\/[^/]+$/.test(routePath)
      || /^\/api\/skills\/[^/]+$/.test(routePath)
    ));
}

function isImageGenerationReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath === "/api/plugins/image-gen/providers"
    || routePath === "/api/media/providers"
    || routePath === "/api/media/image/providers"
    || routePath === "/api/media/video/providers"
    || routePath === "/api/media/tasks"
    || routePath === "/api/plugins/image-gen/tasks"
    || /^\/api\/media\/generated\/[^/]+$/.test(routePath)
    || /^\/api\/media\/tasks\/batch\/[^/]+$/.test(routePath)
    || /^\/api\/media\/tasks\/[^/]+$/.test(routePath)
    || /^\/api\/plugins\/image-gen\/media\/[^/]+$/.test(routePath)
    || /^\/api\/plugins\/image-gen\/tasks\/batch\/[^/]+$/.test(routePath)
    || /^\/api\/plugins\/image-gen\/tasks\/[^/]+$/.test(routePath);
}

function isImageGenerationWriteRoute(verb, routePath) {
  return verb === "PUT" && (
    routePath === "/api/plugins/image-gen/config"
    || routePath === "/api/media/image/config"
    || routePath === "/api/media/video/config"
  );
}

function isImageGenerationProviderManagementRoute(verb, routePath) {
  return (verb === "POST" && /^\/api\/plugins\/image-gen\/providers\/[^/]+\/models$/.test(routePath))
    || (verb === "DELETE" && /^\/api\/plugins\/image-gen\/providers\/[^/]+\/models\/[^/]+$/.test(routePath))
    || (verb === "POST" && /^\/api\/plugins\/image-gen\/tasks\/[^/]+\/retry$/.test(routePath))
    || (verb === "POST" && /^\/api\/media\/(?:image|video)\/providers\/[^/]+\/models$/.test(routePath))
    || (verb === "DELETE" && /^\/api\/media\/(?:image|video)\/providers\/[^/]+\/models\/[^/]+$/.test(routePath))
    || (verb === "POST" && /^\/api\/media\/tasks\/[^/]+\/retry$/.test(routePath));
}

function isLegacyMediaGenerationRoute(verb, routePath) {
  return verb === "POST" && (
    routePath === "/api/media/generate"
    || routePath === "/api/media/image/generate"
    || routePath === "/api/media/video/generate"
    || routePath === "/api/media/asr/transcribe"
  );
}

function isPluginSettingsReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/plugins"
    || routePath === "/api/plugins/config-schemas"
    || routePath === "/api/plugins/event-bus/capabilities"
    || routePath === "/api/plugins/diagnostics"
    || routePath === "/api/plugins/marketplace"
    || routePath === "/api/plugins/marketplace/search"
    || /^\/api\/plugins\/marketplace\/[^/]+\/readme$/.test(routePath)
    || /^\/api\/plugins\/[^/]+\/config-schema$/.test(routePath)
    || /^\/api\/plugins\/[^/]+\/config$/.test(routePath);
}

function isPluginSettingsWriteRoute(verb, routePath) {
  return (verb === "PUT" && (
    routePath === "/api/plugins/settings"
    || /^\/api\/plugins\/[^/]+\/config$/.test(routePath)
    || /^\/api\/plugins\/[^/]+\/enabled$/.test(routePath)
  ))
    || (verb === "POST" && (
      routePath === "/api/plugins/marketplace/install"
      || /^\/api\/plugins\/marketplace\/[^/]+\/install$/.test(routePath)
    ))
    || (verb === "DELETE" && /^\/api\/plugins\/[^/]+$/.test(routePath));
}

function isPluginChatActionRoute(verb, routePath) {
  return verb === "POST" && (
    routePath === "/api/plugins/image-gen/generate-image"
    || routePath === "/api/plugins/image-gen/generate-video"
  );
}

function isPluginUiReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath === "/api/plugins/pages"
    || routePath === "/api/plugins/widgets"
    || routePath === "/api/plugins/ui-host-capabilities"
    || routePath === "/api/plugins/settings-tabs"
    || routePath === "/api/plugins/theme.css"
    || /^\/api\/plugins\/[^/]+\/.+$/.test(routePath);
}

function isPluginAssetReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return /^\/api\/plugins\/[^/]+\/assets\/.+$/.test(routePath);
}

function hasQueryParam(rawPath, key, expected) {
  try {
    const url = new URL(String(rawPath || ""), "http://gsap.local");
    if (!url.searchParams.has(key)) return false;
    if (expected === undefined) return true;
    return url.searchParams.get(key) === expected;
  } catch {
    return false;
  }
}

function isProviderManagementRoute(verb, routePath) {
  if (verb === "POST" && (
    routePath === "/api/providers/test"
    || routePath === "/api/providers/fetch-models"
  )) return true;
  return (verb === "GET" && (
      /^\/api\/providers\/[^/]+\/discovered-models$/.test(routePath)
      || /^\/api\/providers\/[^/]+\/api-key$/.test(routePath)
    ))
    || ((verb === "PUT" || verb === "DELETE") && /^\/api\/providers\/[^/]+\/models\/[^/]+$/.test(routePath));
}

function isBridgeManagementRoute(verb, routePath) {
  if (verb !== "POST") return false;
  return routePath === "/api/bridge/config"
    || routePath === "/api/bridge/settings"
    || routePath === "/api/bridge/owner"
    || routePath === "/api/bridge/stop"
    || routePath === "/api/bridge/test"
    || routePath === "/api/bridge/agently-mail/auth/start"
    || routePath === "/api/bridge/agently-mail/verify"
    || routePath === "/api/bridge/agently-mail/unbind";
}
