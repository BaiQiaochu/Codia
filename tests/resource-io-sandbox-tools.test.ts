import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxedTools } from "../lib/sandbox/index.ts";

describe("ResourceIO sandbox file tools", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function makeTools() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-sandbox-tools-"));
    const workspace = path.join(tempRoot, "workspace");
    const gsapHome = path.join(tempRoot, "gsap-home");
    const agentDir = path.join(gsapHome, "agents", "gsap");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const emitEvent = vi.fn();
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const result = createSandboxedTools(workspace, [], {
      agentDir,
      workspace,
      workspaceFolders: [],
      gsapHome,
      getSandboxEnabled: () => true,
      getSessionPath: () => sessionPath,
      emitEvent,
    } as any);
    return { workspace, emitEvent, tools: result.tools };
  }

  function makeToolsWithResourceIO(resourceIO) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-sandbox-tools-"));
    const workspace = path.join(tempRoot, "workspace");
    const gsapHome = path.join(tempRoot, "gsap-home");
    const agentDir = path.join(gsapHome, "agents", "gsap");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const result = createSandboxedTools(workspace, [], {
      agentDir,
      workspace,
      workspaceFolders: [],
      gsapHome,
      getSandboxEnabled: () => true,
      getSessionPath: () => sessionPath,
      resourceIO,
    } as any);
    return { workspace, tools: result.tools };
  }

  it("routes write, read, and edit through ResourceIO and emits mutation events", async () => {
    const { workspace, emitEvent, tools } = makeTools();
    const realWorkspace = fs.realpathSync(workspace);
    const write = tools.find((tool) => tool.name === "write");
    const read = tools.find((tool) => tool.name === "read");
    const edit = tools.find((tool) => tool.name === "edit");

    await write.execute("write-1", { path: "notes/a.md", content: "hello" });
    expect(fs.readFileSync(path.join(workspace, "notes", "a.md"), "utf-8")).toBe("hello");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_write",
      resourceKey: `local_fs:${path.join(realWorkspace, "notes", "a.md").replace(/\\/g, "/")}`,
    }), expect.any(String));

    const readResult = await read.execute("read-1", { path: "notes/a.md" });
    expect(readResult.content[0].text).toBe("hello");

    await edit.execute("edit-1", {
      path: "notes/a.md",
      edits: [{ oldText: "hello", newText: "hello again" }],
    });
    expect(fs.readFileSync(path.join(workspace, "notes", "a.md"), "utf-8")).toBe("hello again");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_edit",
      resourceKey: `local_fs:${path.join(realWorkspace, "notes", "a.md").replace(/\\/g, "/")}`,
    }), expect.any(String));
  });

  it("routes mount ResourceRefs through ResourceIO instead of local workspace paths", async () => {
    const files = new Map();
    files.set("notes/a.md", "hello");
    const calls: Array<{ method: string; ref: any; content?: string }> = [];
    const failLocal = (method: string, ref: any) => {
      if (ref?.kind === "local-file") {
        throw new Error(`${method} unexpectedly used local-file ${ref.path}`);
      }
    };
    const keyFor = (ref: any) => ref.path || "";
    const resourceIO = {
      stat: vi.fn(async (ref) => {
        failLocal("stat", ref);
        calls.push({ method: "stat", ref });
        const key = keyFor(ref);
        const exists = files.has(key);
        return {
          resourceKey: `mount:${ref.mountId}:${key}`,
          resource: { kind: "mount", mountId: ref.mountId, path: key, provider: "mount" },
          exists,
          isDirectory: false,
          version: { size: exists ? files.get(key).length : 0, mtimeMs: 1 },
        };
      }),
      read: vi.fn(async (ref) => {
        failLocal("read", ref);
        calls.push({ method: "read", ref });
        const key = keyFor(ref);
        return {
          resourceKey: `mount:${ref.mountId}:${key}`,
          resource: { kind: "mount", mountId: ref.mountId, path: key, provider: "mount" },
          content: Buffer.from(files.get(key) || ""),
          version: { size: (files.get(key) || "").length, mtimeMs: 1 },
        };
      }),
      write: vi.fn(async (ref, content) => {
        failLocal("write", ref);
        calls.push({ method: "write", ref, content: String(content) });
        files.set(keyFor(ref), String(content));
        return {
          changeType: "modified",
          resourceKey: `mount:${ref.mountId}:${keyFor(ref)}`,
          resource: { kind: "mount", mountId: ref.mountId, path: keyFor(ref), provider: "mount" },
          version: { size: String(content).length, mtimeMs: 2 },
        };
      }),
      mkdir: vi.fn(async (ref) => {
        failLocal("mkdir", ref);
        calls.push({ method: "mkdir", ref });
        return {
          changeType: "modified",
          resourceKey: `mount:${ref.mountId}:${keyFor(ref)}`,
          resource: { kind: "mount", mountId: ref.mountId, path: keyFor(ref), provider: "mount" },
        };
      }),
      list: vi.fn(async (ref) => {
        failLocal("list", ref);
        calls.push({ method: "list", ref });
        return {
          resourceKey: `mount:${ref.mountId}:${keyFor(ref)}`,
          resource: { kind: "mount", mountId: ref.mountId, path: keyFor(ref), provider: "mount" },
          items: [],
        };
      }),
    };
    const { workspace, tools } = makeToolsWithResourceIO(resourceIO);
    const read = tools.find((tool) => tool.name === "read");
    const write = tools.find((tool) => tool.name === "write");
    const edit = tools.find((tool) => tool.name === "edit");

    const readResult = await read.execute("read-mount", {
      resource: { kind: "mount", mountId: "mount_docs", path: "notes/a.md" },
    });
    await write.execute("write-mount", {
      resource: { kind: "mount", mountId: "mount_docs", path: "notes/b.md" },
      content: "new file",
    });
    await edit.execute("edit-mount", {
      resource: { kind: "mount", mountId: "mount_docs", path: "notes/a.md" },
      edits: [{ oldText: "hello", newText: "hello mount" }],
    });

    expect(readResult.content[0].text).toBe("hello");
    expect(files.get("notes/a.md")).toBe("hello mount");
    expect(files.get("notes/b.md")).toBe("new file");
    expect(fs.existsSync(path.join(workspace, "notes", "a.md"))).toBe(false);
    expect(calls.map((call) => [call.method, call.ref])).toEqual(expect.arrayContaining([
      ["read", { kind: "mount", mountId: "mount_docs", path: "notes/a.md" }],
      ["mkdir", { kind: "mount", mountId: "mount_docs", path: "notes" }],
      ["write", { kind: "mount", mountId: "mount_docs", path: "notes/b.md" }],
      ["write", { kind: "mount", mountId: "mount_docs", path: "notes/a.md" }],
    ]));
  });
});
