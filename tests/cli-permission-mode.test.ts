import { describe, expect, it, vi } from "vitest";
import {
  formatPermissionMode,
  normalizeCliPermissionMode,
  permissionModeFromApprovalMode,
  permissionModeFromCodexRuntimeOptions,
  permissionModeFromSandbox,
  readPermissionMode,
  setPermissionMode,
} from "../lib/cli/permission-mode.ts";

describe("CLI permission mode helpers", () => {
  it("normalizes aliases to Codia session permission modes", () => {
    expect(normalizeCliPermissionMode("read-only")).toBe("read_only");
    expect(normalizeCliPermissionMode("read_only")).toBe("read_only");
    expect(normalizeCliPermissionMode("ask")).toBe("ask");
    expect(normalizeCliPermissionMode("operate")).toBe("operate");
    expect(normalizeCliPermissionMode("auto")).toBe("operate");
  });

  it("maps Codex approval policies to current Codia permission modes", () => {
    expect(permissionModeFromApprovalMode("untrusted")).toBe("read_only");
    expect(permissionModeFromApprovalMode("on-request")).toBe("ask");
    expect(permissionModeFromApprovalMode("on-failure")).toBe("ask");
    expect(permissionModeFromApprovalMode("never")).toBe("operate");
  });

  it("maps Codex sandbox modes conservatively to current Codia permission modes", () => {
    expect(permissionModeFromSandbox("read-only")).toBe("read_only");
    expect(permissionModeFromSandbox("workspace-write")).toBe("ask");
    expect(permissionModeFromSandbox("danger-full-access")).toBe("operate");
  });

  it("combines Codex approval and sandbox flags using the safer mode", () => {
    expect(permissionModeFromCodexRuntimeOptions({
      approvalMode: "never",
      sandboxMode: "workspace-write",
    })).toBe("ask");
    expect(permissionModeFromCodexRuntimeOptions({
      approvalMode: "never",
      sandboxMode: "danger-full-access",
    })).toBe("operate");
    expect(permissionModeFromCodexRuntimeOptions({
      approvalMode: null,
      sandboxMode: null,
    })).toBe(null);
  });

  it("formats permission modes for terminal status", () => {
    expect(formatPermissionMode("read_only")).toContain("只读");
    expect(formatPermissionMode("ask")).toContain("询问");
    expect(formatPermissionMode("operate")).toContain("自动执行");
  });

  it("reads and writes current session permission mode through existing API", async () => {
    const client = {
      get: vi.fn(async () => ({ permissionMode: "ask" })),
      post: vi.fn(async (_path, body) => ({ permissionMode: body.permissionMode, sessionPath: body.sessionPath })),
    };

    await expect(readPermissionMode(client, { sessionPath: "/tmp/s.jsonl" })).resolves.toEqual({ permissionMode: "ask" });
    await expect(setPermissionMode(client, "operate", { sessionPath: "/tmp/s.jsonl" })).resolves.toEqual({
      permissionMode: "operate",
      sessionPath: "/tmp/s.jsonl",
    });

    expect(client.get).toHaveBeenCalledWith("/session-permission-mode?sessionPath=%2Ftmp%2Fs.jsonl");
    expect(client.post).toHaveBeenCalledWith("/session-permission-mode", {
      permissionMode: "operate",
      sessionPath: "/tmp/s.jsonl",
      currentSessionOnly: true,
    });
  });

  it("rejects unknown permission modes before calling the backend", async () => {
    const client = { post: vi.fn() };
    await expect(setPermissionMode(client, "danger", { sessionPath: "/tmp/s.jsonl" })).rejects.toThrow("未知权限模式");
    expect(client.post).not.toHaveBeenCalled();
  });
});
