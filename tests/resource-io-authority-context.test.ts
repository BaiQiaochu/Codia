import { describe, expect, it, vi } from "vitest";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";

describe("ResourceIO operation context", () => {
  it("passes principal and reason into mutation audit without changing provider call shape", async () => {
    const audit = { record: vi.fn() };
    const provider = {
      id: "local_fs" as const,
      capabilities: () => ({ write: true }),
      write: vi.fn(async (_ref, content) => ({
        changeType: "modified" as const,
        resourceKey: "local_fs:/repo/a.md",
        resource: { kind: "local-file" as const, path: "/repo/a.md", provider: "local_fs" },
        content,
      })),
    };
    const resourceIO = new ResourceIO({ providers: { local_fs: provider }, audit });

    await resourceIO.write({ kind: "local-file", path: "/repo/a.md" }, "next", {
      source: "agent_tool",
      reason: "agent_write",
      principal: { kind: "agent", sessionId: "sess_1", userId: "user_1" },
    });

    expect(provider.write).toHaveBeenCalledWith({ kind: "local-file", path: "/repo/a.md" }, "next");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "allowed",
      operation: "write",
      reason: "agent_write",
      principal: { kind: "agent", sessionId: "sess_1", userId: "user_1" },
      resourceKey: "local_fs:/repo/a.md",
    }));
  });

  it("records denied capability decisions with a sanitized message", async () => {
    const audit = { record: vi.fn() };
    const resourceIO = new ResourceIO({
      providers: {
        url: { id: "url" as const, capabilities: () => ({ write: false }) },
      },
      audit,
    });

    await expect(resourceIO.write({ kind: "url", url: "https://example.com/a.md" }, "x", {
      principal: { kind: "plugin", pluginId: "p1", connectionKind: "cloud" },
    })).rejects.toMatchObject({ code: "capability_denied" });

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "denied",
      operation: "write",
      providerId: "url",
      principal: { kind: "plugin", pluginId: "p1", connectionKind: "cloud" },
      safeMessage: expect.any(String),
    }));
  });
});
