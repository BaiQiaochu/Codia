import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
const createWin32Exec = vi.fn(() => vi.fn(async () => ({ exitCode: 0 })));

vi.mock("../lib/sandbox/win32-exec.js", () => ({
  createWin32Exec,
}));

vi.mock("../lib/pi-sdk/index.js", () => {
  const makeTool = (name) => ({ name, execute: vi.fn(async () => ({ content: [] })) });
  return {
    createReadTool: vi.fn(() => makeTool("read")),
    createWriteTool: vi.fn(() => makeTool("write")),
    createEditTool: vi.fn(() => makeTool("edit")),
    createBashTool: vi.fn((cwd, opts: any = {}) => ({
      name: "bash",
      execute: vi.fn((toolCallId, params: any = {}) => {
        const exec = opts.operations?.exec;
        if (!exec) return { content: [] };
        return exec(params.command, cwd, params);
      }),
    })),
    createGrepTool: vi.fn(() => makeTool("grep")),
    createFindTool: vi.fn(() => makeTool("find")),
    createLsTool: vi.fn(() => makeTool("ls")),
  };
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
  vi.clearAllMocks();
});

describe("createSandboxedTools on Windows", () => {
  it("constructs a sandboxed restricted-token exec plus an unsandboxed fallback exec", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");

    const getExternalReadPaths = () => ["C:\\outside\\brief.md"];
    const getSandboxNetworkEnabled = () => true;
    const { tools } = createSandboxedTools("C:\\work", [], {
      agentDir: "C:\\hana\\agents\\hana",
      workspace: "C:\\work",
      workspaceFolders: [],
      hanakoHome: "C:\\hana",
      getSandboxEnabled: () => true,
      getSandboxNetworkEnabled,
      getExternalReadPaths,
    } as any);

    expect(createWin32Exec).toHaveBeenCalledWith();
    const bashTool = tools.find((tool) => tool.name === "bash");
    await bashTool.execute("call-1", { command: "echo ok" });
    const sandboxCall = (createWin32Exec as any).mock.calls.find(([options]: any[]) => options?.sandbox);
    const sandbox = sandboxCall?.[0]?.sandbox;
    expect(sandbox?.policy?.mode).toBe("standard");
    expect(sandbox?.gsapHome).toBe("C:\\hana");
    expect(sandbox?.getExternalReadPaths).toBe(getExternalReadPaths);
    expect(sandbox?.getSandboxNetworkEnabled).toBe(getSandboxNetworkEnabled);
  });
});
