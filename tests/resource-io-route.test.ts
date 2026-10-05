import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxResourceIO } from "../lib/resource-io/sandbox-resource-io.ts";
import { createResourceIoRoute } from "../server/routes/resource-io.ts";

describe("ResourceIO HTTP route", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    vi.useRealTimers();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeApp() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-io-route-"));
    const workspace = path.join(tmpDir, "workspace");
    const gsapHome = path.join(tmpDir, "home");
    const sessionPath = path.join(tmpDir, "agents", "gsap", "sessions", "main.jsonl");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(path.join(workspace, "note.txt"), "hello resource io\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));

    const events: any[] = [];
    const watchRelease = vi.fn();
    const resourceIO = createSandboxResourceIO({
      cwd: workspace,
      agentDir: path.join(tmpDir, "agents", "gsap"),
      gsapHome,
      getSessionPath: () => sessionPath,
      emitEvent: (event, scopedSessionPath) => events.push({ ...event, scopedSessionPath }),
    });

    const engine = {
      getResourceIO: () => resourceIO,
      resourceWatchDiagnostics: () => ({ subscriptions: 0, watches: [] }),
      retainResourceWatch: vi.fn(() => watchRelease),
      subscribeResourceWatch: vi.fn(() => ({ subscriptionId: "sub_1" })),
      unsubscribeResourceWatch: vi.fn(() => true),
    };

    const app = new Hono();
    app.route("/api", createResourceIoRoute(engine));
    return { app, workspace, events, resourceIO, engine, watchRelease };
  }

  it("reads and lists local file resources through the mounted API shape", async () => {
    const { app } = makeApp();

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "note.txt" } }),
    });
    expect(readRes.status).toBe(200);
    await expect(readRes.json()).resolves.toMatchObject({
      content: "hello resource io\n",
      encoding: "utf-8",
      resource: { kind: "local-file", provider: "local_fs" },
    });

    const listRes = await app.request("/api/resource-io/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "." } }),
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "note.txt", isDirectory: false }),
    ]));
  });

  it("returns binary resources as base64 instead of lossy utf-8 text", async () => {
    const { app } = makeApp();

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "image.bin" }, encoding: "base64" }),
    });

    expect(readRes.status).toBe(200);
    await expect(readRes.json()).resolves.toMatchObject({
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]).toString("base64"),
      contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]).toString("base64"),
      encoding: "base64",
      resource: { kind: "local-file", provider: "local_fs" },
    });
  });

  it("rejects binary resources requested as utf-8 without silently replacing bytes", async () => {
    const { app } = makeApp();

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "image.bin" } }),
    });

    expect(readRes.status).toBe(400);
    await expect(readRes.json()).resolves.toMatchObject({
      code: "invalid_resource_encoding",
      safeMessage: expect.stringContaining("request encoding \"base64\""),
    });
  });

  it("releases retained watches after the route-level lease expires", async () => {
    vi.useFakeTimers();
    const { app, engine, watchRelease } = makeApp();

    const res = await app.request("/api/resource-io/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "." } }),
    });
    expect(res.status).toBe(200);
    expect(engine.retainResourceWatch).toHaveBeenCalledOnce();
    expect(watchRelease).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);

    expect(watchRelease).toHaveBeenCalledOnce();
  });

  it("writes local resources and emits a resource.changed event", async () => {
    const { app, workspace, events } = makeApp();

    const writeRes = await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "generated/out.txt" },
        content: "written through api",
      }),
    });

    expect(writeRes.status).toBe(200);
    await expect(writeRes.json()).resolves.toMatchObject({
      changeType: "created",
      resource: { kind: "local-file", provider: "local_fs" },
    });
    expect(fs.readFileSync(path.join(workspace, "generated", "out.txt"), "utf-8"))
      .toBe("written through api");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource.changed",
        changeType: "created",
        source: "api",
      }),
    ]));
  });

  it("decodes base64 write content before writing local resources", async () => {
    const { app, workspace } = makeApp();
    const bytes = Buffer.from([0, 1, 2, 250, 255]);

    const writeRes = await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "generated/binary.bin" },
        content: bytes.toString("base64"),
        encoding: "base64",
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(fs.readFileSync(path.join(workspace, "generated", "binary.bin"))).toEqual(bytes);
  });

  it("exposes resource event catch-up from the route", async () => {
    const { app } = makeApp();

    await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "generated/event.txt" },
        content: "event",
      }),
    });

    const res = await app.request("/api/resource-io/events?since=0");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      stale: false,
      latestSequence: expect.any(Number),
      events: [expect.objectContaining({
        type: "resource.changed",
        changeType: "created",
      })],
    });
  });

  it("passes API request context into write operations", async () => {
    const { app, resourceIO } = makeApp();
    const write = vi.spyOn(resourceIO, "write");

    const res = await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-route-1" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "generated/context.txt" },
        content: "context",
        sessionId: "sess_1",
        principal: { userId: "user_1", studioId: "studio_1" },
      }),
    });

    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      "context",
      expect.objectContaining({
        source: "api",
        sessionId: "sess_1",
        requestId: "req-route-1",
        principal: expect.objectContaining({
          kind: "api",
          userId: "user_1",
          studioId: "studio_1",
          sessionId: "sess_1",
          requestId: "req-route-1",
        }),
      }),
    );
  });
});
