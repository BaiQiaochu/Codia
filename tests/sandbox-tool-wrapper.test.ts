import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;

async function importToolWrapperAsWin32() {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.resetModules();
  return import("../lib/sandbox/tool-wrapper.js");
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("wrapBashTool Windows PathGuard preflight", () => {
  it("lets restricted-token helper handle command read paths", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    const result = await wrapped.execute("call-1", {
      command: 'ls "/c/Program Files/GitHub CLI/gh.exe"',
    });

    expect(guard.check).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalled();
    expect(result.content[0].text).toBe("ok");
  });

  it("records sandbox metadata and execution result for bash tools", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const recordToolCall = vi.fn();
    const tool = {
      name: "bash",
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    };
    const guard = {
      check: vi.fn(() => ({ allowed: true })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace", {
      recordToolCall,
      getTraceContext: () => ({
        traceId: "trace-sandbox",
        toolTraceId: "tooltrace-bash",
        agentId: "codia",
        executionBoundary: { boundaryId: "execb_server_studio" },
      }),
      getSandboxEnabled: () => true,
      getSandboxNetworkEnabled: () => true,
      platform: "win32-restricted-token",
    });
    const result = await wrapped.execute("call-1", { command: "echo ok" });

    expect(result.content[0].text).toBe("ok");
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      traceId: "trace-sandbox",
      toolTraceId: "tooltrace-bash",
      toolName: "bash",
      agentId: "codia",
      sandbox: expect.objectContaining({
        enabled: true,
        networkEnabled: true,
        platform: "win32-restricted-token",
        boundaryId: "execb_server_studio",
      }),
      result: expect.objectContaining({ status: "success" }),
    }));
  });

  it("checks bash redirection targets as writes", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    const result = await wrapped.execute("call-2", {
      command: 'printf secret > "/c/Users/alice/.ssh/config"',
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Users\\alice\\.ssh\\config", "write");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toBeTruthy();
  });

  it("does not treat POSIX /dev/null redirection as a file write", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.js");
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: true })),
    };

    const wrapped = wrapBashTool(tool, guard, "/workspace");
    await wrapped.execute("call-dev-null", { command: "true 2>/dev/null" });

    expect(guard.check).not.toHaveBeenCalledWith("/dev/null", "write");
    expect(tool.execute).toHaveBeenCalled();
  });

  it("still checks explicit POSIX /dev/null deletion", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.js");
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "/workspace");
    await wrapped.execute("call-dev-null-delete", { command: "rm /dev/null" });

    expect(guard.check).toHaveBeenCalledWith("/dev/null", "delete");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("checks mutating shell command operands with their operation intent", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    await wrapped.execute("call-3", {
      command: "rm -rf /c/Users/alice/.ssh",
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Users\\alice\\.ssh", "delete");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("still blocks managed config writes before sandbox execution", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: true })),
    };
    const checkManagedConfigWrite = vi.fn(() => ({ allowed: false, reason: "managed config" }));

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace", { checkManagedConfigWrite });
    const result = await wrapped.execute("call-4", {
      command: 'printf secret > "/c/Users/alice/.codia/config.yaml"',
    });

    expect(checkManagedConfigWrite).toHaveBeenCalledWith("C:\\Users\\alice\\.codia\\config.yaml", "write");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toBeTruthy();
  });
});
