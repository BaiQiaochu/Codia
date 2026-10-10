// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-mobile-workbench-"));
}

async function makeApp(engine) {
  const app = new Hono();
  const { createMobileWorkbenchRoute } = await import("../server/routes/mobile-workbench.js");
  app.route("/api", createMobileWorkbenchRoute(engine));
  return app;
}

describe("mobile workbench route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("lists default workspace files without exposing absolute server paths", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "note.md"), "hello", "utf-8");
    fs.writeFileSync(path.join(workspace, ".secret"), "hidden", "utf-8");

    const app = await makeApp({
      codiaHome: path.join(tmpDir, "codia-home"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/files");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ rootId: "default", subdir: "" });
    expect(data).not.toHaveProperty("basePath");
    expect(data.files.map((file) => file.name)).toEqual(["note.md"]);
    expect(JSON.stringify(data)).not.toContain(workspace);
  });

  it("returns Codia mobile bootstrap metadata without leaking provider secrets", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const app = await makeApp({
      codiaHome: path.join(tmpDir, "codia-home"),
      userDir: path.join(tmpDir, "codia-home", "user"),
      agentDir: path.join(tmpDir, "codia-home", "agents", "codia"),
      deskCwd: workspace,
      homeCwd: workspace,
      getLocale: () => "zh-CN",
      agentName: "Codia",
      userName: "Owner",
      currentAgentId: "codia",
      config: { cwd_history: [workspace] },
      agent: {
        config: {
          agent: { yuan: "codia" },
          providers: { openai: { api_key: "secret-key" } },
        },
      },
      listAgents: () => [{
        id: "codia",
        name: "Codia",
        yuan: "codia",
        isPrimary: true,
        hasAvatar: false,
        homeFolder: workspace,
        chatModel: { id: "gpt-5.5", provider: "openai" },
      }],
      getAppearance: () => ({ theme: "codia-dark", serif: false }),
    });

    const res = await app.request("/api/mobile/bootstrap");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      locale: "zh-CN",
      agentName: "Codia",
      userName: "Owner",
      currentAgentId: "codia",
      agentYuan: "codia",
      homeFolder: workspace,
      cwdHistory: [workspace],
      appearance: { theme: "codia-dark" },
    });
    expect(data.agents).toEqual([{
      id: "codia",
      name: "Codia",
      yuan: "codia",
      isPrimary: true,
      isCurrent: false,
      hasAvatar: false,
      chatModel: { id: "gpt-5.5", provider: "openai" },
      homeFolder: workspace,
      memoryMasterEnabled: true,
    }]);
    expect(JSON.stringify(data)).not.toContain("secret-key");
    expect(JSON.stringify(data).toLowerCase()).toContain("codia");
  });

  it("uses a localized fallback user name for mobile bootstrap", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const app = await makeApp({
      codiaHome: path.join(tmpDir, "codia-home"),
      deskCwd: workspace,
      homeCwd: workspace,
      getLocale: () => "zh-CN",
      agentName: "Codia",
      currentAgentId: "codia",
    });

    const res = await app.request("/api/mobile/bootstrap");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      locale: "zh-CN",
      userName: "用户",
    });
  });

  it("serves UTF-8 file content with HEAD and Range support", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "粘贴图片.md"), "abcdef", "utf-8");
    const app = await makeApp({
      codiaHome: path.join(tmpDir, "codia-home"),
      deskCwd: workspace,
      homeCwd: workspace,
    });
    const query = `name=${encodeURIComponent("粘贴图片.md")}`;

    const head = await app.request(`/api/mobile/workbench/content?${query}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect(head.headers.get("content-disposition")).toContain("filename*=UTF-8''");

    const range = await app.request(`/api/mobile/workbench/content?${query}`, {
      headers: { Range: "bytes=1-3" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(await range.text()).toBe("bcd");
  });

  it("safe-deletes mobile files into recoverable trash instead of hard removing bytes", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const codiaHome = path.join(tmpDir, "codia-home");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "draft.txt"), "keep me recoverable", "utf-8");
    const app = await makeApp({
      codiaHome,
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "safeDelete", name: "draft.txt" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, action: "safeDelete" });
    expect(data.trashId).toMatch(/^trash_/);
    expect(fs.existsSync(path.join(workspace, "draft.txt"))).toBe(false);
    const trashDir = path.join(codiaHome, "trash", "mobile-workbench", data.trashId);
    expect(fs.readFileSync(path.join(trashDir, "payload"), "utf-8")).toBe("keep me recoverable");
    expect(JSON.parse(fs.readFileSync(path.join(trashDir, "metadata.json"), "utf-8")))
      .toMatchObject({ originalName: "draft.txt", rootId: "default" });
  });

  it("rejects path traversal in mobile file names and subdirectories", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = await makeApp({
      codiaHome: path.join(tmpDir, "codia-home"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", subdir: "../outside", name: "x.md", content: "no" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_subdir" });
  });

  it("denies remote mobile writes without files.write scope", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = new Hono();
    const { createMobileWorkbenchRoute } = await import("../server/routes/mobile-workbench.js");
    app.use("*", async (c, next) => {
      c.set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        deviceId: "device_1",
        scopes: ["files.read"],
      }));
      await next();
    });
    app.route("/api", createMobileWorkbenchRoute({
      codiaHome: path.join(tmpDir, "codia-home"),
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    }));

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", name: "x.md", content: "no" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "insufficient_scope",
      capability: "files.write",
    });
  });

  it("records a consumed write lease and security audit entry for scoped remote writes", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const codiaHome = path.join(tmpDir, "codia-home");
    fs.mkdirSync(workspace, { recursive: true });
    const app = new Hono();
    const { createMobileWorkbenchRoute } = await import("../server/routes/mobile-workbench.js");
    app.use("*", async (c, next) => {
      c.set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        deviceId: "device_1",
        scopes: ["files"],
      }));
      await next();
    });
    app.route("/api", createMobileWorkbenchRoute({
      codiaHome,
      deskCwd: workspace,
      homeCwd: workspace,
      currentAgentId: "codia",
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    }));

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", name: "remote.md", content: "remote body" }),
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(workspace, "remote.md"), "utf-8")).toBe("remote body");
    const leases = JSON.parse(fs.readFileSync(path.join(codiaHome, "security", "execution-leases.json"), "utf-8"));
    expect(leases.leases).toHaveLength(1);
    expect(leases.leases[0]).toMatchObject({
      status: "consumed",
      commandClass: "write_files",
      sandboxProfile: "workspace_write",
      backupPolicy: "snapshot_before_write",
    });
    const audit = fs.readFileSync(path.join(codiaHome, "logs", "security-audit.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit).toEqual([expect.objectContaining({
      action: "mobile_workbench.writeText",
      result: "success",
      leaseId: leases.leases[0].leaseId,
    })]);
  });

  it("lists active local_fs studio mounts through the mobile workbench route", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "mounted-docs");
    const codiaHome = path.join(tmpDir, "codia-home");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "mount body", "utf-8");
    upsertStudioMount(codiaHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const app = await makeApp({
      codiaHome,
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    });

    const res = await app.request("/api/mobile/workbench/files?rootId=mount_docs");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      rootId: "mount_docs",
      files: [{ name: "mounted.md", isDir: false }],
    });
    expect(JSON.stringify(data)).not.toContain(mountRoot);
  });
});
