// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-web-auth-route-"));
}

function runtimeContext() {
  return {
    serverId: "server_local",
    serverNodeId: "node_local",
    userId: "user_local",
    studioId: "studio_local",
    connectionKind: "lan",
    credentialKind: "device_credential",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ["chat", "resources", "files"],
  };
}

describe("web auth route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("exchanges a paired device credential for an HttpOnly browser session cookie", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.js");
    const { createServerAuthService } = await import("../core/server-auth.js");
    const { createWebAuthRoute } = await import("../server/routes/web-auth.js");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Phone Browser",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read", "files.read", "files.write"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const authService = createServerAuthService({
      gsapHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext,
    });
    const app = new Hono();
    app.route("/api", createWebAuthRoute({
      gsapHome: tmpDir,
      authService,
      getConnectionKind: () => "lan",
      secureCookies: false,
      now: () => "2026-05-16T00:00:01.000Z",
    }));

    const login = await app.request("/api/web-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mobile Safari" },
      body: JSON.stringify({ credential: issued.secret }),
    });

    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("gsap_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(issued.secret);
    expect(await login.json()).toMatchObject({
      ok: true,
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        scopes: ["chat", "resources.read", "files.read", "files.write"],
      },
    });

    const session = await app.request("/api/web-auth/session", {
      headers: { Cookie: setCookie.split(";")[0] },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      principal: { userId: "user_local", studioId: "studio_local" },
    });
  });

  it("allows local account password login only over local or secure transport", async () => {
    tmpDir = makeTmpDir();
    const { setLocalAccountPassword } = await import("../core/local-user-account.js");
    const { createServerAuthService } = await import("../core/server-auth.js");
    const { createWebAuthRoute } = await import("../server/routes/web-auth.js");
    fs.writeFileSync(path.join(tmpDir, "users.json"), JSON.stringify({
      schemaVersion: 1,
      defaultUserId: "user_local",
      users: [{
        userId: "user_local",
        kind: "legacy_owner",
        username: "gsap-owner",
        displayName: "G-SAP Owner",
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
      }],
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }), "utf-8");
    setLocalAccountPassword(tmpDir, {
      password: "correct horse battery staple",
      now: "2026-05-16T00:00:00.000Z",
    });
    const authService = createServerAuthService({
      gsapHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext,
    });
    const app = new Hono();
    let connectionKind = "lan";
    app.route("/api", createWebAuthRoute({
      gsapHome: tmpDir,
      authService,
      getConnectionKind: () => connectionKind,
      getRuntimeContext: runtimeContext,
      secureCookies: false,
      now: () => "2026-05-16T00:00:01.000Z",
    }));

    const insecure = await app.request("/api/web-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "gsap-owner", password: "correct horse battery staple" }),
    });
    expect(insecure.status).toBe(400);
    expect(await insecure.json()).toMatchObject({ error: "password_login_requires_secure_context" });

    const spoofedHeader = await app.request("/api/web-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "gsap-owner", password: "correct horse battery staple" }),
    });
    expect(spoofedHeader.status).toBe(400);

    const secure = await app.request("https://gsap.example.test/api/web-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "gsap-owner", password: "correct horse battery staple" }),
    });
    expect(secure.status).toBe(200);
    expect(secure.headers.get("set-cookie")).toContain("gsap_session=");
    expect(await secure.json()).toMatchObject({
      principal: {
        kind: "account_user",
        credentialKind: "password",
        userId: "user_local",
        scopes: ["chat", "resources.read", "files.read", "files.write"],
      },
    });

    connectionKind = "local";
    const local = await app.request("/api/web-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "gsap-owner", password: "correct horse battery staple" }),
    });
    expect(local.status).toBe(200);
  });
});
