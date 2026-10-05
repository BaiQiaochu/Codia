import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapResourceIoFileTools, __resourceIoAgentToolsForTest } from "../lib/resource-io/agent-tools.ts";
import { createResourceIoToolOperations } from "../lib/resource-io/pi-tool-operations.ts";

describe("ResourceIO agent tools", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.unstubAllGlobals();
  });

  it("parses mount ResourceRefs before falling back to local path aliases", () => {
    const target = __resourceIoAgentToolsForTest.resolveToolTarget({
      resource: { kind: "mount", mountId: "mount_docs", path: "notes/a.md" },
    }, "/workspace");

    expect(target).toEqual({
      kind: "mount",
      mountId: "mount_docs",
      path: "notes/a.md",
    });
  });

  it("normalizes local path aliases before delegating write through the ResourceIO-backed tool", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-io-tools-"));
    const execute = vi.fn(async (_toolCallId, params) => {
      fs.mkdirSync(path.dirname(params.path), { recursive: true });
      fs.writeFileSync(params.path, params.content, "utf-8");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const [write] = wrapResourceIoFileTools([
      {
        name: "write",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        execute,
      },
    ], {
      cwd: tmpDir,
      getSessionPath: () => "/sessions/a.jsonl",
      resourceIO: {},
    });

    const result = await write.execute("write-1", {
      file_path: "notes/a.md",
      content: "# A\n",
    });

    const absolutePath = path.join(tmpDir, "notes", "a.md");
    expect(result.content[0].text).toBe("ok");
    expect(execute).toHaveBeenCalledWith(
      "write-1",
      expect.objectContaining({ path: absolutePath, content: "# A\n" }),
    );
    expect(fs.readFileSync(absolutePath, "utf-8")).toBe("# A\n");
  });

  it("routes local path file-tool writes through ResourceIO operations", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-io-local-tool-"));
    const resourceIO = {
      write: vi.fn(async () => ({
        changeType: "created",
        resourceKey: "local_fs:/workspace/notes/a.md",
        resource: { kind: "local-file", path: "/workspace/notes/a.md" },
      })),
      stat: vi.fn(async () => ({ exists: false, isDirectory: false })),
    };
    const ops = createResourceIoToolOperations({
      cwd: tmpDir,
      resourceIO: resourceIO as any,
      getSessionPath: () => "/sessions/a.jsonl",
      getSessionIdentity: () => ({
        sessionId: "sess_1",
        sessionPath: "/sessions/a.jsonl",
        userId: "user_1",
        studioId: "studio_1",
      }),
    });
    const filePath = path.join(tmpDir, "notes", "a.md");

    await ops.write.writeFile(filePath, "# A\n");

    expect(resourceIO.write).toHaveBeenCalledWith(
      { kind: "local-file", path: filePath },
      "# A\n",
      expect.objectContaining({
        source: "agent_tool",
        reason: "agent_write",
        sessionPath: "/sessions/a.jsonl",
        sessionId: "sess_1",
        principal: expect.objectContaining({
          kind: "agent",
          sessionId: "sess_1",
          sessionPath: "/sessions/a.jsonl",
          userId: "user_1",
          studioId: "studio_1",
        }),
      }),
    );
  });

  it("fails closed instead of delegating to legacy file tools when ResourceIO is unavailable", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "legacy write" }] }));
    const [write] = wrapResourceIoFileTools([
      {
        name: "write",
        parameters: { type: "object", required: ["path", "content"], properties: {} },
        execute,
      },
    ], {
      cwd: "/workspace",
      getSessionPath: () => "/sessions/a.jsonl",
    });

    const result = await write.execute("write-1", {
      path: "notes/a.md",
      content: "# A\n",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("ResourceIO kernel");
  });

  it("passes SessionFile references to read and rejects SessionFile writes explicitly", async () => {
    const readExecute = vi.fn(async (_toolCallId, params) => ({
      content: [{ type: "text", text: `read:${params.path}` }],
    }));
    const writeExecute = vi.fn();
    const resourceIO = {
      materialize: vi.fn(async () => ({ filePath: "/tmp/materialized.md" })),
    };
    const [read, write] = wrapResourceIoFileTools([
      { name: "read", parameters: { type: "object", required: ["path"], properties: {} }, execute: readExecute },
      { name: "write", parameters: { type: "object", required: ["path"], properties: {} }, execute: writeExecute },
    ], {
      cwd: "/workspace",
      getSessionPath: () => "/sessions/a.jsonl",
      resourceIO,
    });

    const readResult = await read.execute("read-1", {
      resource: { kind: "session-file", fileId: "sf_123", sessionPath: "/sessions/owner.jsonl" },
    });
    const writeResult = await write.execute("write-1", {
      fileId: "sf_123",
      content: "new",
    });

    expect(readResult.content[0].text).toBe("read:/tmp/materialized.md");
    expect(resourceIO.materialize).toHaveBeenCalledWith({
      kind: "session-file",
      fileId: "sf_123",
      sessionPath: "/sessions/owner.jsonl",
    });
    expect(readExecute).toHaveBeenCalledWith(
      "read-1",
      expect.objectContaining({ path: "/tmp/materialized.md" }),
    );
    expect(writeExecute).not.toHaveBeenCalled();
    expect(writeResult.content[0].text).toContain("cannot be written or edited directly");
  });

  it("rejects resource-shaped SessionFile write and edit targets before local delegation", async () => {
    const execute = vi.fn();
    const [write, edit] = wrapResourceIoFileTools([
      { name: "write", parameters: { type: "object", required: ["path", "content"], properties: {} }, execute },
      { name: "edit", parameters: { type: "object", required: ["path", "oldText", "newText"], properties: {} }, execute },
    ], {
      cwd: "/workspace",
      getSessionPath: () => "/sessions/a.jsonl",
      resourceIO: {
        materialize: vi.fn(),
      },
    });

    const writeResult = await write.execute("write-session-file", {
      resource: { kind: "session-file", fileId: "sf_doc" },
      content: "new",
    });
    const editResult = await edit.execute("edit-session-file", {
      resource: { kind: "session-file", fileId: "sf_doc" },
      oldText: "old",
      newText: "new",
    });

    expect(writeResult.content[0].text).toContain("cannot be written or edited directly");
    expect(editResult.content[0].text).toContain("cannot be written or edited directly");
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows URL reads and keeps URL targets read-only", async () => {
    const delegateExecute = vi.fn();
    const resourceIO = {
      read: vi.fn(async () => ({
        content: Buffer.from("hello url"),
        version: { size: 9, etag: "\"abc\"" },
      })),
    };
    const [read, write] = wrapResourceIoFileTools([
      { name: "read", parameters: { type: "object", required: ["path"], properties: {} }, execute: delegateExecute },
      { name: "write", parameters: { type: "object", required: ["path"], properties: {} }, execute: delegateExecute },
    ], {
      cwd: "/workspace",
      getSessionPath: () => "/sessions/a.jsonl",
      resourceIO,
    });

    const readResult = await read.execute("read-url", { url: "https://example.com/a.txt" });
    const writeResult = await write.execute("write-url", { url: "https://example.com/a.txt", content: "x" });

    expect(readResult.content[0].text).toContain("hello url");
    expect(resourceIO.read).toHaveBeenCalledWith({ kind: "url", url: "https://example.com/a.txt" });
    expect(writeResult.content[0].text).toContain("read-only");
    expect(delegateExecute).not.toHaveBeenCalled();
  });

  it("rejects direct writes to read-only resource ids before delegated path handling", async () => {
    const execute = vi.fn();
    const [write] = wrapResourceIoFileTools([
      { name: "write", parameters: { type: "object", required: ["path"], properties: {} }, execute },
    ], {
      cwd: "/workspace",
      resourceIO: {},
      withResourceTarget: vi.fn(),
    });

    const result = await write.execute("write-resource", {
      resource: { kind: "resource", resourceId: "res_1" },
      content: "new",
    });

    expect(result.content[0].text).toContain("read-only");
    expect(execute).not.toHaveBeenCalled();
  });
});
