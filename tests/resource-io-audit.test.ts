import { describe, expect, it, vi } from "vitest";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";

describe("ResourceIO audit", () => {
  function makeAuditSink() {
    const events: any[] = [];
    return {
      events,
      record: vi.fn((event) => {
        const fullEvent = {
          type: "resource.audit",
          sequence: events.length + 1,
          occurredAt: "2026-06-22T00:00:00.000Z",
          ...event,
        };
        events.push(fullEvent);
        return fullEvent;
      }),
    };
  }

  it("records expected-version conflicts without emitting changed events", async () => {
    const audit = { record: vi.fn() };
    const changed = vi.fn();
    const provider = {
      id: "local_fs" as const,
      capabilities: () => ({ writeExpectedVersion: true }),
      writeExpectedVersion: vi.fn(async () => ({
        ok: false as const,
        conflict: true as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        version: { mtimeMs: 2, size: 10 },
      })),
    };
    const resourceIO = new ResourceIO({
      providers: { local_fs: provider },
      eventBus: { changed } as any,
      audit,
    });

    const result = await resourceIO.writeExpectedVersion(
      { kind: "local-file", path: "/repo/a.md" },
      "next",
      { mtimeMs: 1, size: 10 },
      {
        reason: "route_write",
        principal: { kind: "api", requestId: "req_1" },
      },
    );

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(changed).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "conflict",
      operation: "writeExpectedVersion",
      reason: "route_write",
      resourceKey: "local_fs:/repo/a.md",
      principal: { kind: "api", requestId: "req_1" },
    }));
  });

  it("records denied read-side operations with principal context", async () => {
    const audit = makeAuditSink();
    const resourceIO = new ResourceIO({
      providers: {
        local_fs: { id: "local_fs" as const, capabilities: () => ({ read: false }) },
      },
      audit,
    });

    await expect(resourceIO.read(
      { kind: "local-file", path: "/workspace/private.md" },
      {
        source: "plugin",
        reason: "plugin:notes:read",
        principal: { kind: "plugin", pluginId: "notes", sessionId: "sess_1" },
        sessionId: "sess_1",
      },
    )).rejects.toMatchObject({ code: "capability_denied" });

    expect(audit.events[0]).toMatchObject({
      outcome: "denied",
      operation: "read",
      providerId: "local_fs",
      reason: "plugin:notes:read",
      sessionId: "sess_1",
      principal: { kind: "plugin", pluginId: "notes", sessionId: "sess_1" },
    });
  });

  it("audits allowed read-side operations only when auditRead is requested", async () => {
    const audit = makeAuditSink();
    const provider = {
      id: "local_fs" as const,
      capabilities: () => ({ read: true }),
      read: vi.fn(async () => ({
        resourceKey: "local_fs:/workspace/a.md",
        resource: { kind: "local-file" as const, provider: "local_fs" as const, path: "/workspace/a.md" },
        content: Buffer.from("a"),
      })),
    };
    const resourceIO = new ResourceIO({ providers: { local_fs: provider }, audit });

    await resourceIO.read({ kind: "local-file", path: "/workspace/a.md" }, { reason: "plain-read" });
    expect(audit.events).toHaveLength(0);

    await resourceIO.read(
      { kind: "local-file", path: "/workspace/a.md" },
      { reason: "audited-read", auditRead: true, principal: { kind: "plugin", pluginId: "notes" } },
    );

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      outcome: "allowed",
      operation: "read",
      reason: "audited-read",
      principal: { kind: "plugin", pluginId: "notes" },
    });
  });
});
