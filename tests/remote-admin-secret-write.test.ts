import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-remote-admin-"));
}

function withPrincipal(app, principal) {
  app.use("*", async (c, next) => {
    c.set("authPrincipal", Object.freeze(principal));
    await next();
  });
}

function remotePrincipal(scopes) {
  return {
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    userId: "user_owner",
    studioId: "studio_home",
    deviceId: "device_phone",
    credentialId: "cred_phone",
    scopes,
  };
}

function readAuditLog(root) {
  const file = path.join(root, "logs", "security-audit.jsonl");
  return fs.readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("trusted remote admin secret writes", () => {
  let tmpDir = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("rejects remote config secret mutations without secrets.write", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    tmpDir = makeTmpDir();
    const saveProvider = vi.fn();
    const engine = {
      hanakoHome: tmpDir,
      config: {},
      configPath: path.join(tmpDir, "config.yaml"),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({ deepseek: { api_key: "sk-saved" } }),
        saveProvider,
      },
    };
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["settings.write", "providers.manage"]));
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: { api_key: "sk-remote-new" },
        },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      error: "secret_write_scope_required",
      scope: "secrets.write",
      fields: ["providers.deepseek.api_key"],
    });
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it("allows scoped remote config secret mutations and records an audit event without the secret value", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    tmpDir = makeTmpDir();
    const saveProvider = vi.fn();
    const engine = {
      hanakoHome: tmpDir,
      config: {},
      configPath: path.join(tmpDir, "config.yaml"),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({ deepseek: { api_key: "sk-saved" } }),
        saveProvider,
      },
    };
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["settings.write", "providers.manage", "secrets.write"]));
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: { api_key: "sk-remote-new", base_url: "https://api.deepseek.com" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("deepseek", {
      api_key: "sk-remote-new",
      base_url: "https://api.deepseek.com",
    });

    const rawAudit = fs.readFileSync(path.join(tmpDir, "logs", "security-audit.jsonl"), "utf-8");
    expect(rawAudit).not.toContain("sk-remote-new");
    expect(readAuditLog(tmpDir)[0]).toMatchObject({
      action: "settings.config.update",
      result: "success",
      actor: {
        kind: "device",
        deviceId: "device_phone",
        credentialId: "cred_phone",
      },
      secretFields: ["providers.deepseek.api_key"],
    });
  });

  it("requires providers.manage before a remote config request can mutate provider definitions", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    tmpDir = makeTmpDir();
    const saveProvider = vi.fn();
    const engine = {
      hanakoHome: tmpDir,
      config: {},
      configPath: path.join(tmpDir, "config.yaml"),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({ deepseek: { base_url: "https://old.example/v1" } }),
        saveProvider,
      },
    };
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["settings.write", "secrets.write"]));
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: { base_url: "https://new.example/v1" },
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "insufficient_scope",
      scope: "providers.manage",
    });
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it("requires secrets.write before a remote bridge credential can be saved", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    tmpDir = makeTmpDir();
    const agent = {
      id: "hana",
      config: { bridge: { telegram: { token: "tg-saved", enabled: false } } },
      updateConfig: vi.fn(),
    };
    const engine = {
      hanakoHome: tmpDir,
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["bridge.manage"]));
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "telegram",
        credentials: { token: "tg-new" },
        enabled: false,
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "secret_write_scope_required",
      fields: ["credentials.token"],
    });
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });
});
