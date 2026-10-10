import { describe, expect, it } from "vitest";

const localPrincipal = Object.freeze({
  kind: "local_user",
  credentialKind: "loopback_token",
  connectionKind: "local",
  scopes: ["chat", "resources", "tools"],
});

function devicePrincipal(scopes = []) {
  return Object.freeze({
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    scopes,
  });
}

describe("HTTP route security policy", () => {
  it("keeps local owner access unrestricted", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/providers/summary",
      principal: localPrincipal,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/shutdown",
      principal: localPrincipal,
    })).toMatchObject({ allowed: true });
  });

  it("allows scoped devices to read masked settings without opening local-only admin routes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const principal = devicePrincipal(["chat", "resources.read", "settings.read"]);

    for (const [method, path] of [
      ["GET", "/api/config"],
      ["GET", "/api/providers/summary"],
      ["GET", "/api/preferences/models"],
      ["GET", "/api/bridge/status"],
      ["GET", "/api/bridge/agently-mail/status"],
      ["GET", "/api/agents/codia/config"],
      ["GET", "/api/speech-recognition/providers"],
      ["GET", "/api/experiments"],
      ["GET", "/api/experiments/memory/cache-snapshot-reflection/observation?agentId=codia"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({ allowed: true });
    }

    for (const [method, path] of [
      ["POST", "/api/shutdown"],
      ["GET", "/internal/browser"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({
        allowed: false,
        status: 403,
        error: "local_only_route",
        reason: "local_owner_required",
      });
    }
  });

  it("separates remote settings writes, provider management, and bridge management scopes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const settingsWriter = devicePrincipal(["settings.write"]);
    const providerManager = devicePrincipal(["providers.manage"]);
    const bridgeManager = devicePrincipal(["bridge.manage"]);

    expect(authorizeHttpRoute({ method: "PUT", path: "/api/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/agents/codia/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/preferences/models", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/speech-recognition/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/preferences/setup-complete", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PATCH", path: "/api/experiments/memory.cache_snapshot_reflection", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "DELETE",
      path: "/api/experiments/memory/cache-snapshot-reflection/observation",
      principal: settingsWriter,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/providers/test", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/providers/fetch-models", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/providers/deepseek/models/deepseek-chat", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "DELETE", path: "/api/providers/minimax/models/image-01", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/config", principal: bridgeManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/agently-mail/auth/start", principal: bridgeManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/agently-mail/verify", principal: bridgeManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/agently-mail/unbind", principal: bridgeManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/wukong/capabilities", principal: devicePrincipal(["chat"]) }))
      .toMatchObject({ allowed: true, policy: { kind: "scope", scope: "chat" } });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/wukong/tasks/run", principal: devicePrincipal(["chat"]) }))
      .toMatchObject({ allowed: true, policy: { kind: "scope", scope: "chat" } });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/wukong/runtime/tasks/run", principal: devicePrincipal(["chat"]) }))
      .toMatchObject({ allowed: true, policy: { kind: "scope", scope: "chat" } });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/config", principal: settingsWriter }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/wukong/tasks/run", principal: devicePrincipal(["settings.read"]) }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "chat" });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/wukong/runtime/tasks/run", principal: devicePrincipal(["settings.read"]) }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "chat" });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/config", principal: providerManager }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
  });

  it("gates PWA bootstrap routes, chat, resources, and workbench by scope", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.js");
    const reader = devicePrincipal(["chat", "resources.read", "files.read"]);
    const writer = devicePrincipal(["chat", "resources.read", "files.read", "files.write"]);

    for (const [method, path] of [
      ["GET", "/mobile/"],
      ["GET", "/mobile/index.html"],
      ["GET", "/mobile/assets/index.js"],
      ["GET", "/mobile/styles.css"],
      ["GET", "/mobile/manifest.webmanifest"],
      ["GET", "/mobile/sw.js"],
      ["GET", "/mobile/icon.png"],
      ["GET", "/mobile/lib/i18n.js"],
      ["GET", "/mobile/themes/studio-light.css"],
      ["GET", "/mobile/locales/zh.json"],
      ["GET", "/desktop/index.html"],
      ["GET", "/desktop/assets/index.js"],
      ["GET", "/desktop/styles.css"],
      ["GET", "/preview/html/pv_123?previewToken=preview_only"],
      ["GET", "/preview/html/pv_123/assets/images/chart.png?previewToken=preview_only"],
      ["POST", "/api/web-auth/login"],
      ["GET", "/api/web-auth/session"],
      ["POST", "/api/pwa-auth/login"],
      ["GET", "/api/pwa-auth/status"],
    ]) {
      expect(classifyHttpRoute({ method, path })).toMatchObject({ kind: "public" });
      expect(authorizeHttpRoute({ method, path, principal: null })).toMatchObject({ allowed: true });
    }

    for (const [method, path] of [
      ["GET", "/api/server/identity"],
      ["GET", "/api/sessions"],
      ["POST", "/api/sessions/continue-deleted-agent"],
      ["POST", "/api/prompts/optimize"],
      ["GET", "/api/skills?agentId=codia&runtime=1"],
      ["POST", "/api/skills/translate"],
      ["GET", "/api/models/auxiliary-vision"],
      ["POST", "/api/confirm/confirm_1"],
      ["GET", "/api/avatar/agent"],
      ["GET", "/api/agents/codia/avatar?t=1"],
      ["GET", "/api/desk/skills"],
      ["GET", "/api/resources/res_1"],
      ["POST", "/api/resources/res_1/ticket"],
      ["GET", "/api/desk/files"],
      ["GET", "/api/desk/search-files"],
      ["GET", "/api/resource-io/watch-diagnostics"],
      ["GET", "/api/resource-io/events"],
      ["POST", "/api/resource-io/subscribe"],
      ["POST", "/api/resource-io/read"],
      ["POST", "/api/resource-io/list"],
      ["GET", "/api/preferences/workspace-ui-state"],
      ["POST", "/api/preview/html"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: reader }))
        .toMatchObject({ allowed: true });
    }

    expect(authorizeHttpRoute({ method: "POST", path: "/api/desk/files", principal: reader }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", reason: "missing_required_scope", requiredScope: "files.write" });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/desk/files", principal: writer }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/resource-io/write", principal: reader }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", reason: "missing_required_scope", requiredScope: "files.write" });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/resource-io/write", principal: writer }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/sessions/continue-deleted-agent", principal: devicePrincipal(["files.write"]) }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", reason: "missing_required_scope", requiredScope: "chat" });
    expect(authorizeHttpRoute({ method: "DELETE", path: "/api/studio/workspaces/mount_client", principal: reader }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", reason: "missing_required_scope", requiredScope: "files.write" });
    expect(authorizeHttpRoute({ method: "DELETE", path: "/api/studio/workspaces/mount_client", principal: writer }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/config", principal: reader }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
  });

  it("defaults unknown API routes to studio owner instead of ordinary scoped devices", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/new-surface",
      principal: devicePrincipal(["chat", "resources.read", "admin"]),
    })).toMatchObject({
      allowed: false,
      status: 403,
      error: "studio_owner_required",
      reason: "studio_owner_required",
    });

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/new-surface",
      principal: devicePrincipal(["chat", "studio.owner"]),
    })).toMatchObject({
      allowed: true,
      policy: { kind: "studio_owner" },
    });
  });

  it("allows legacy desktop-owner scope sets to satisfy studio owner routes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const legacyDesktopOwner = devicePrincipal([
      "chat",
      "resources.read",
      "files.read",
      "files.write",
      "settings.read",
      "settings.write",
      "providers.manage",
      "secrets.write",
      "bridge.manage",
    ]);

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/usage/llm",
      principal: legacyDesktopOwner,
    })).toMatchObject({
      allowed: true,
      policy: { kind: "studio_owner" },
    });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/usage/llm",
      principal: legacyDesktopOwner,
    })).toMatchObject({
      allowed: false,
      error: "local_only_route",
    });
  });

  it("allows authenticated chat principals to request and load plugin iframe surfaces", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const principal = devicePrincipal(["chat"]);

    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/plugins/iframe-ticket",
      principal,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/plugins/calendar/page",
      principal,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/plugins/theme.css",
      principal,
    })).toMatchObject({ allowed: true });
  });

  it("keeps settings sub-surfaces scoped instead of falling through to studio owner", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.js");
    const settingsReader = devicePrincipal(["settings.read"]);
    const settingsWriter = devicePrincipal(["settings.write"]);
    const providerManager = devicePrincipal(["providers.manage"]);

    expect(classifyHttpRoute({ method: "GET", path: "/api/plugins/mcp/oauth/callback?code=abc" }))
      .toMatchObject({ kind: "public" });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/plugins/mcp/oauth/callback?code=abc",
      principal: null,
    })).toMatchObject({ allowed: true });

    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/preferences/computer-use"],
      ["GET", "/api/plugins"],
      ["GET", "/api/plugins/config-schemas"],
      ["GET", "/api/plugins/diagnostics"],
      ["GET", "/api/plugins/marketplace"],
      ["GET", "/api/plugins/marketplace/demo/readme"],
      ["GET", "/api/plugins/demo/config-schema"],
      ["GET", "/api/plugins/demo/config"],
      ["GET", "/api/plugins/image-gen/providers?agentId=codia"],
      ["GET", "/api/plugins/image-gen/tasks"],
      ["GET", "/api/plugins/image-gen/media/media_1"],
      ["GET", "/api/plugins/image-gen/tasks/task_1"],
      ["GET", "/api/plugins/image-gen/tasks/batch/batch_1"],
      ["GET", "/api/media/providers?capability=image_generation"],
      ["GET", "/api/media/image/providers"],
      ["GET", "/api/media/video/providers"],
      ["GET", "/api/media/tasks"],
      ["GET", "/api/media/tasks/task_1"],
      ["GET", "/api/media/tasks/batch/batch_1"],
      ["GET", "/api/media/generated/image_1.png"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: settingsReader }))
        .toMatchObject({ allowed: true });
    }

    for (const [method, path] of [
      ["PUT", "/api/preferences/computer-use"],
      ["PUT", "/api/plugins/settings"],
      ["PUT", "/api/plugins/demo/config"],
      ["PUT", "/api/plugins/demo/enabled"],
      ["POST", "/api/plugins/marketplace/demo/install"],
      ["DELETE", "/api/plugins/demo"],
      ["PUT", "/api/plugins/image-gen/config?agentId=codia"],
      ["PUT", "/api/media/image/config?agentId=codia"],
      ["PUT", "/api/media/video/config?agentId=codia"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: settingsWriter }))
        .toMatchObject({ allowed: true });
    }

    for (const [method, path] of [
      ["POST", "/api/plugins/image-gen/providers/minimax/models"],
      ["DELETE", "/api/plugins/image-gen/providers/minimax/models/video-01"],
      ["POST", "/api/plugins/image-gen/tasks/task_1/retry"],
      ["POST", "/api/media/image/providers/minimax/models"],
      ["POST", "/api/media/video/providers/jimeng-cli/models"],
      ["DELETE", "/api/media/image/providers/minimax/models/image-01"],
      ["DELETE", "/api/media/video/providers/jimeng-cli/models/video-01"],
      ["POST", "/api/media/tasks/task_1/retry"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: providerManager }))
        .toMatchObject({ allowed: true });
    }

    for (const [method, path] of [
      ["POST", "/api/media/generate"],
      ["POST", "/api/media/image/generate"],
      ["POST", "/api/media/video/generate"],
      ["POST", "/api/media/asr/transcribe"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: devicePrincipal(["chat"]) }))
        .toMatchObject({ allowed: true });
    }
  });

  it("allows scoped settings principals to manage skill bundles", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const settingsReader = devicePrincipal(["settings.read"]);
    const settingsWriter = devicePrincipal(["settings.write"]);

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/skills/bundles?agentId=codia",
      principal: settingsReader,
    })).toMatchObject({ allowed: true });

    for (const [method, path] of [
      ["POST", "/api/skills/install"],
      ["POST", "/api/skills/bundles"],
      ["PUT", "/api/skills/bundles/order"],
      ["PUT", "/api/skills/bundles/writing-bundle"],
      ["PATCH", "/api/agents/codia/skills/code-review"],
      ["PATCH", "/api/agents/codia/skill-bundles/writing-bundle"],
      ["POST", "/api/skills/bundles/writing-bundle/export"],
      ["DELETE", "/api/skills/bundles/writing-bundle"],
      ["DELETE", "/api/skills/code-review"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: settingsWriter }))
        .toMatchObject({ allowed: true });
    }
  });

  it("allows plugin surface session principals only for their own plugin route", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.js");
    const { normalizePrincipal } = await import("../core/security-principal.ts");
    const principal = normalizePrincipal({
      kind: "plugin",
      pluginId: "demo-plugin",
      credentialKind: "plugin_surface_session",
      connectionKind: "local",
      scopes: [],
    });

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/plugins/demo-plugin/page",
      principal,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/plugins/other-plugin/page",
      principal,
    })).toMatchObject({ allowed: false });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/plugins",
      principal,
    })).toMatchObject({ allowed: false });
  });
});
