// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("desk route", () => {
  it("returns structured route errors for desk activity sessions, heartbeat, and cron store failures", async () => {
    const { createDeskRoute } = await import("../server/routes/desk.js");
    const app = new Hono();
    const engine = {
      deskCwd: process.cwd(),
      homeCwd: process.cwd(),
      agentsDir: process.cwd(),
      listAgents: () => [],
      getActivityStore: () => null,
      getAgent: () => null,
      getStudioCronStore: () => null,
    };
    app.route("/api", createDeskRoute(engine, { scheduler: { getHeartbeat: () => null } }));

    const missingActivity = await app.request("/api/desk/activities/missing/session");
    expect(missingActivity.status).toBe(404);
    expect(await missingActivity.json()).toEqual({
      error: {
        code: "activity_not_found",
        message: "activity not found",
      },
    });

    const heartbeat = await app.request("/api/desk/heartbeat?agentId=agent-a", { method: "POST" });
    expect(heartbeat.status).toBe(503);
    expect(await heartbeat.json()).toEqual({
      error: {
        code: "heartbeat_unavailable",
        message: "Heartbeat not initialized",
      },
    });

    const cron = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    });
    expect(cron.status).toBe(503);
    expect(await cron.json()).toEqual({
      error: {
        code: "cron_store_unavailable",
        message: "Desk not initialized",
      },
    });
  });

  it("keeps beautify cover prompts readable and tied to the target markdown file", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "server/routes/desk.ts"), "utf-8");

    expect(source).toContain("\u76ee\u6807\u6587\u4ef6\uff1a${filePath}");
    expect(source).not.toContain("?????${filePath}");
  });

  it("rejects path-like workspace entry names instead of basename-normalizing them", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, "old.txt"), "old", "utf-8");
      fs.writeFileSync(path.join(cwd, "exists.txt"), "exists", "utf-8");

      const { createDeskRoute } = await import("../server/routes/desk.js");
      const app = new Hono();
      app.route("/api", createDeskRoute({ deskCwd: cwd, homeCwd: cwd, codiaHome: tempRoot }, null));

      const createRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "../evil.md", content: "bad" }),
      });
      expect(await createRes.json()).toMatchObject({ error: "invalid name" });
      expect(fs.existsSync(path.join(cwd, "evil.md"))).toBe(false);

      const mkdirRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name: "nested/child" }),
      });
      expect(await mkdirRes.json()).toMatchObject({ error: "invalid name" });
      expect(fs.existsSync(path.join(cwd, "child"))).toBe(false);

      const renameRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", oldName: "old.txt", newName: "../new.txt" }),
      });
      expect(await renameRes.json()).toMatchObject({ error: "invalid name" });
      expect(fs.existsSync(path.join(cwd, "old.txt"))).toBe(true);
      expect(fs.existsSync(path.join(cwd, "new.txt"))).toBe(false);

      const duplicateRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "exists.txt", content: "overwrite" }),
      });
      expect(await duplicateRes.json()).toMatchObject({ error: "target already exists" });
      expect(fs.readFileSync(path.join(cwd, "exists.txt"), "utf-8")).toBe("exists");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects upload action with absolute source paths for non-local-owner principals", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-desk-route-"));
    try {
      const codiaHome = path.join(tempRoot, "codia-home");
      const cwd = path.join(tempRoot, "workspace");
      const externalDir = path.join(tempRoot, "outside");
      fs.mkdirSync(codiaHome, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      const externalFile = path.join(externalDir, "secret.txt");
      fs.writeFileSync(externalFile, "secret bytes", "utf-8");

      const { createDeskRoute } = await import("../server/routes/desk.js");
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("authPrincipal", Object.freeze({
          kind: "device",
          connectionKind: "lan",
          credentialKind: "device_credential",
          principalId: "device:phone-1",
          scopes: ["chat", "resources.read", "files.read", "files.write"],
        }));
        await next();
      });
      app.route("/api", createDeskRoute({ deskCwd: cwd, homeCwd: cwd, codiaHome }, null));

      const res = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", paths: [externalFile] }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("local owner");
      expect(fs.existsSync(path.join(cwd, "secret.txt"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows upload action for local-owner principals", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-desk-route-"));
    try {
      const codiaHome = path.join(tempRoot, "codia-home");
      const cwd = path.join(tempRoot, "workspace");
      const externalDir = path.join(tempRoot, "drag-source");
      fs.mkdirSync(codiaHome, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      const draggedFile = path.join(externalDir, "note.md");
      fs.writeFileSync(draggedFile, "dragged content", "utf-8");

      const { createDeskRoute } = await import("../server/routes/desk.js");
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("authPrincipal", Object.freeze({
          kind: "local_user",
          connectionKind: "local",
          credentialKind: "loopback_token",
          scopes: ["*"],
        }));
        await next();
      });
      app.route("/api", createDeskRoute({ deskCwd: cwd, homeCwd: cwd, codiaHome }, null));

      const res = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", paths: [draggedFile] }),
      });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(cwd, "note.md"))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
