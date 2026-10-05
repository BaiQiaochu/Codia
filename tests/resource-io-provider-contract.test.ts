import { describe, expect, it, vi } from "vitest";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";
import { providerIdForResourceRef } from "../lib/resource-io/resource-refs.ts";

describe("ResourceIO provider contract", () => {
  it("maps ResourceRef kinds to stable provider ids", () => {
    expect(providerIdForResourceRef({ kind: "local-file", path: "/repo/a.md" })).toBe("local_fs");
    expect(providerIdForResourceRef({ kind: "mount", mountId: "docs", path: "a.md" })).toBe("mount");
    expect(providerIdForResourceRef({ kind: "session-file", fileId: "sf_1" })).toBe("session_file");
    expect(providerIdForResourceRef({ kind: "resource", resourceId: "res_1" })).toBe("resource");
    expect(providerIdForResourceRef({ kind: "url", url: "https://example.com/a.txt" })).toBe("url");
  });

  it("dispatches by ResourceRef kind, checks capabilities, and emits mutation events", async () => {
    const changed = vi.fn();
    const localProvider = {
      id: "local_fs" as const,
      capabilities: () => ({ stat: true, read: true, write: true, edit: true }),
      stat: vi.fn(async () => ({
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        exists: true,
        isDirectory: false,
      })),
      read: vi.fn(async () => ({
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        content: Buffer.from("hello"),
      })),
      write: vi.fn(async () => ({
        changeType: "modified" as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
      })),
      edit: vi.fn(async () => ({
        changeType: "modified" as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
      })),
    };
    const resourceIO = new ResourceIO({
      providers: { local_fs: localProvider },
      eventBus: { changed } as any,
      getSessionPath: () => "/sessions/a.jsonl",
    });

    await resourceIO.stat({ kind: "local-file", path: "/repo/a.md" });
    await resourceIO.read({ kind: "local-file", path: "/repo/a.md" });
    expect(changed).not.toHaveBeenCalled();

    await resourceIO.write({ kind: "local-file", path: "/repo/a.md" }, "hello again", {
      source: "agent_tool",
      reason: "agent_write",
    });
    await resourceIO.edit({ kind: "local-file", path: "/repo/a.md" }, [{ oldText: "hello", newText: "hello again" }], {
      source: "agent_tool",
      reason: "agent_edit",
    });

    expect(localProvider.edit).toHaveBeenCalledWith(
      { kind: "local-file", path: "/repo/a.md" },
      [{ oldText: "hello", newText: "hello again" }],
    );
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({
      source: "agent_tool",
      reason: "agent_edit",
      sessionPath: "/sessions/a.jsonl",
    }));
  });

  it("returns stable errors for missing providers and denied capabilities", async () => {
    const resourceIO = new ResourceIO({
      providers: {
        local_fs: {
          id: "local_fs",
          capabilities: () => ({ read: false }),
        },
      },
    });

    await expect(resourceIO.read({ kind: "resource", resourceId: "res_missing" }))
      .rejects.toMatchObject({ code: "provider_not_available" });
    await expect(resourceIO.read({ kind: "local-file", path: "/repo/a.md" }))
      .rejects.toMatchObject({ code: "capability_denied" });
  });

  it("rejects cross-provider copy with a typed ResourceIO error", async () => {
    const resourceIO = new ResourceIO({
      providers: {
        local_fs: { id: "local_fs", capabilities: () => ({ copy: true }), copy: vi.fn() },
        mount: { id: "mount", capabilities: () => ({ copy: true }), copy: vi.fn() },
      },
    });

    await expect(resourceIO.copy(
      { kind: "local-file", path: "/repo/a.md" },
      { kind: "mount", mountId: "docs", path: "a.md" },
    )).rejects.toMatchObject({
      code: "cross_provider_copy_unsupported",
      status: 501,
      fromProvider: "local_fs",
      toProvider: "mount",
    });
  });

  it("dispatches route-grade rename, move, trash, and expected-version writes through providers", async () => {
    const changed = vi.fn();
    const renamed = vi.fn();
    const deleted = vi.fn();
    const provider = {
      id: "local_fs" as const,
      capabilities: () => ({
        writeExpectedVersion: true,
        rename: true,
        move: true,
        trash: true,
      }),
      writeExpectedVersion: vi.fn(async () => ({
        ok: false as const,
        conflict: true as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        version: { mtimeMs: 1, size: 3 },
      })),
      rename: vi.fn(async () => ({
        oldResourceKey: "local_fs:/repo/a.md",
        newResourceKey: "local_fs:/repo/b.md",
        oldResource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        newResource: { kind: "local-file" as const, path: "/repo/b.md", provider: "local_fs" },
      })),
      move: vi.fn(async () => ({
        oldResourceKey: "local_fs:/repo/b.md",
        newResourceKey: "local_fs:/repo/archive/b.md",
        oldResource: { kind: "local-file" as const, path: "/repo/b.md", provider: "local_fs" },
        newResource: { kind: "local-file" as const, path: "/repo/archive/b.md", provider: "local_fs" },
      })),
      trash: vi.fn(async () => ({
        resourceKey: "local_fs:/repo/archive/b.md",
        resource: { kind: "local-file" as const, path: "/repo/archive/b.md", provider: "local_fs" },
        trashId: "trash_1",
        payloadPath: "/trash/payload",
      })),
    };
    const resourceIO = new ResourceIO({
      providers: { local_fs: provider },
      eventBus: { changed, renamed, deleted } as any,
      getSessionPath: () => "/sessions/a.jsonl",
    });

    const conflict = await resourceIO.writeExpectedVersion(
      { kind: "local-file", path: "/repo/a.md" },
      "next",
      { mtimeMs: 0, size: 3 },
      { reason: "route_write" },
    );
    expect(conflict).toMatchObject({ ok: false, conflict: true });
    expect(changed).not.toHaveBeenCalled();

    await resourceIO.rename(
      { kind: "local-file", path: "/repo/a.md" },
      { kind: "local-file", path: "/repo/b.md" },
      { reason: "route_rename" },
    );
    await resourceIO.move(
      { kind: "local-file", path: "/repo/b.md" },
      { kind: "local-file", path: "/repo/archive/b.md" },
      { reason: "route_move" },
    );
    await resourceIO.trash(
      { kind: "local-file", path: "/repo/archive/b.md" },
      { namespace: "workbench", metadata: { originalName: "b.md" } },
      { reason: "route_trash" },
    );

    expect(provider.writeExpectedVersion).toHaveBeenCalledWith(
      { kind: "local-file", path: "/repo/a.md" },
      "next",
      { mtimeMs: 0, size: 3 },
    );
    expect(renamed).toHaveBeenCalledWith(expect.objectContaining({
      oldResourceKey: "local_fs:/repo/a.md",
      newResourceKey: "local_fs:/repo/b.md",
      reason: "route_rename",
      source: "api",
      sessionPath: "/sessions/a.jsonl",
    }));
    expect(renamed).toHaveBeenCalledWith(expect.objectContaining({
      oldResourceKey: "local_fs:/repo/b.md",
      newResourceKey: "local_fs:/repo/archive/b.md",
      reason: "route_move",
      source: "api",
      sessionPath: "/sessions/a.jsonl",
    }));
    expect(deleted).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "local_fs:/repo/archive/b.md",
      reason: "route_trash",
      source: "api",
      sessionPath: "/sessions/a.jsonl",
    }));
  });
});
