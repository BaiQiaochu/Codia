import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSettingsSnapshotRoute } from "../server/routes/settings-snapshot.js";

let tmpRoot: string | null = null;

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function writeServerIdentity(root: string) {
  await writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_snapshot",
    label: "Snapshot Server",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  await writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_owner",
    users: [{
      userId: "user_owner",
      kind: "legacy_owner",
      displayName: "Owner",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  await writeJson(path.join(root, "studios.json"), {
    schemaVersion: 1,
    defaultStudioId: "studio_home",
    studios: [{
      studioId: "studio_home",
      ownerUserId: "user_owner",
      label: "Home Studio",
      kind: "personal",
      storage: { provider: "legacy_codia_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
}

function localOwner() {
  return {
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    serverId: "server_snapshot",
    serverNodeId: "server_snapshot",
    userId: "user_owner",
    studioId: "studio_home",
    scopes: ["settings.read", "settings.write", "bridge.manage"],
  };
}

async function makeEngine() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codia-settings-snapshot-"));
  const agentsDir = path.join(tmpRoot, "agents");
  const userDir = path.join(tmpRoot, "user");
  const agentDir = path.join(agentsDir, "agent-a");
  await writeServerIdentity(tmpRoot);
  await writeJson(path.join(tmpRoot, "server-network.json"), {
    schemaVersion: 1,
    mode: "lan",
    listenHost: "0.0.0.0",
    listenPort: 14500,
    customRemote: { enabled: false, baseUrl: null, wsUrl: null },
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  await writeFile(path.join(agentDir, "config.yaml"), [
    "agent:",
    "  name: Agent A",
    "desk:",
    "  home_folder: /tmp/agent-a",
    "memory:",
    "  enabled: false",
    "experience:",
    "  enabled: false",
    "bridge:",
    "  telegram:",
    "    token: tg-secret",
    "    enabled: true",
    "",
  ].join("\n"));
  await writeFile(path.join(agentDir, "identity.md"), "identity");
  await writeFile(path.join(agentDir, "ishiki.md"), "ishiki");
  await writeFile(path.join(agentDir, "public-ishiki.md"), "public");
  await writeFile(path.join(agentDir, "pinned.md"), "keep this");
  await writeFile(path.join(userDir, "profile.md"), "user profile");

  return {
    codiaHome: tmpRoot,
    agentsDir,
    userDir,
    currentAgentId: "agent-a",
    listAgents: () => [{ id: "agent-a", name: "Agent A" }],
    getAgent: () => ({ id: "agent-a", config: { bridge: { telegram: { token: "tg-secret", enabled: true } } }, tools: [] }),
    providerRegistry: {
      getAllProvidersRaw: () => ({}),
      get: () => null,
    },
    pluginManager: {
      getAllTools: () => [],
      getAllowFullAccess: () => false,
      getUserPluginsDir: () => path.join(userDir, "plugins"),
      getSettingsTabs: () => [],
    },
    preferences: {
      getExperimentValue: () => undefined,
    },
    getComputerUseSettings: () => ({ enabled: false }),
    getSharedModels: () => ({ utility: { id: "utility" }, utility_large: { id: "utility-large" } }),
    getThinkingLevel: () => "medium",
    getSearchConfig: () => ({ provider: "", api_key: "", api_keys: {} }),
    getUtilityApi: () => ({ provider: "", base_url: "", api_key: "" }),
    getQuickChatPreferences: () => ({ shortcut: "CommandOrControl+Shift+K", reuseTimeoutMinutes: 12 }),
    getNotificationPreferences: () => ({ turnCompletion: "when_session_unfocused" }),
    getBridgePermissionMode: () => "operate",
    getBridgeReadOnly: () => false,
    getBridgeReceiptEnabled: () => false,
    getBridgeRichStreamingEnabled: () => false,
    getBridgeIndex: () => ({}),
    getSpeechRecognitionConfig: () => ({ enabled: false }),
    getKeepAwake: () => false,
    getHeartbeatMaster: () => false,
    getAutomationPermissionMode: () => "auto",
  };
}

describe("settings snapshot route", () => {
  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("returns one settings snapshot without losing explicit false values", async () => {
    const engine = await makeEngine();
    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.agentId).toBe("agent-a");
    expect(body.config.agent.name).toBe("Agent A");
    expect(body.config.memory.enabled).toBe(false);
    expect(body.config.keep_awake).toBe(false);
    expect(body.config.desk.heartbeat_master).toBe(false);
    expect(body.preferences.bridge).toEqual({
      permissionMode: "operate",
      readOnly: false,
      receiptEnabled: false,
      richStreamingEnabled: false,
    });
    expect(body.preferences.computerUse.settings.enabled).toBe(false);
    expect(body.preferences.computerUse.status).toMatchObject({
      enabled: false,
      activeLease: null,
    });
    expect(body.preferences.computerUse.selectedProviderId)
      .toBe(body.preferences.computerUse.status.selectedProviderId);
    expect(body.preferences.speechRecognition.enabled).toBe(false);
    expect(body.plugins.allowFullAccess).toBe(false);
    expect(body.plugins.devToolsEnabled).toBe(false);
    expect(body.identity).toBe("identity");
    expect(body.ishiki).toBe("ishiki");
    expect(body.publicIshiki).toBe("public");
    expect(body.userProfile).toBe("user profile");
  });

  it("includes first-frame access and bridge truth in the unified settings snapshot", async () => {
    const engine = await makeEngine();
    const bridgeManager = {
      getStatus: () => ({
        telegram: { status: "connected", error: null },
      }),
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze(localOwner()));
      await next();
    });
    app.route("/api", createSettingsSnapshotRoute(engine, {
      bridgeManagerRef: bridgeManager,
      runtimeState: { mode: "lan", listenHost: "0.0.0.0", actualPort: 14500 },
      listLanAddresses: () => ["192.168.31.75"],
    } as any));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.access.network).toMatchObject({
      mode: "lan",
      listenHost: "0.0.0.0",
      actualPort: 14500,
      lanMobileUrl: "http://192.168.31.75:14500/mobile/",
      restartRequired: false,
    });
    expect(body.bridgeStatus).toMatchObject({
      agentId: "agent-a",
      telegram: {
        enabled: true,
        configured: true,
        status: "connected",
        agentId: "agent-a",
      },
      permissionMode: "operate",
      readOnly: false,
      receiptEnabled: false,
      richStreamingEnabled: false,
    });
    expect(JSON.stringify(body)).not.toContain("tg-secret");
  });
});
