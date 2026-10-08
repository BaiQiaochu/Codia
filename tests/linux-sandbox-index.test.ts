import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/sandbox/platform.js", () => ({
  detectPlatform: vi.fn(() => "bwrap"),
  checkAvailability: vi.fn(() => false),
}));

vi.mock("../lib/pi-sdk/index.js", () => {
  const makeTool = (name) => ({
    name,
    parameters: name === "read"
      ? {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
        },
        required: ["path"],
      }
      : undefined,
    execute: vi.fn(async (_toolCallId, params) => ({ content: [], details: { params } })),
  });
  return {
    createReadTool: vi.fn(() => makeTool("read")),
    createWriteTool: vi.fn(() => makeTool("write")),
    createEditTool: vi.fn(() => makeTool("edit")),
    createBashTool: vi.fn((cwd, opts: any = {}) => ({
      name: "bash",
      execute: vi.fn(async (_toolCallId, params) => {
        if (opts.operations?.exec) {
          return opts.operations.exec(params.command, cwd, {});
        }
        return { content: [{ type: "text", text: "direct bash" }] };
      }),
    })),
    createGrepTool: vi.fn(() => makeTool("grep")),
    createFindTool: vi.fn(() => makeTool("find")),
    createLsTool: vi.fn(() => makeTool("ls")),
  };
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("createSandboxedTools on Linux", () => {
  it("fails closed for bash when bwrap is unavailable while sandbox remains enabled", async () => {
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    const result = createSandboxedTools("/work", [], {
      agentDir: "/hana/agents/hana",
      workspace: "/work",
      workspaceFolders: [],
      hanakoHome: "/hana",
      getSandboxEnabled: () => true,
    } as any);

    const bash = result.tools.find((tool) => tool.name === "bash");
    const output = await bash.execute("call-1", { command: "pwd" });

    expect(output.content[0].text).not.toBe("direct bash");
    expect(output.content[0].text).toMatch(/bwrap|sandbox|沙盒|系统/);
  });

  it("uses the direct bash fallback when the user explicitly disables sandbox", async () => {
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    const result = createSandboxedTools("/work", [], {
      agentDir: "/hana/agents/hana",
      workspace: "/work",
      workspaceFolders: [],
      hanakoHome: "/hana",
      getSandboxEnabled: () => false,
    } as any);

    const bash = result.tools.find((tool) => tool.name === "bash");
    const output = await bash.execute("call-2", { command: "pwd" });

    expect(output.content[0].text).toBe("direct bash");
  });

  it("resolves read fileId through the current session before path guard and SDK execution", async () => {
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    const result = createSandboxedTools("/work", [], {
      agentDir: "/hana/agents/hana",
      workspace: "/work",
      workspaceFolders: [],
      hanakoHome: "/hana",
      getSandboxEnabled: () => true,
      getSessionPath: () => "/hana/agents/hana/sessions/main.jsonl",
      resolveSessionFile: vi.fn((fileId: any, options: any) => {
        expect(fileId).toBe("sf_cjk_digits");
        expect(options).toEqual({ sessionPath: "/hana/agents/hana/sessions/main.jsonl" });
        return {
          fileId,
          filePath: "/work/测试123/报告2026.txt",
          realPath: "/work/测试123/报告2026.txt",
          status: "available",
        };
      }),
    } as any);

    const read = result.tools.find((tool) => tool.name === "read");
    expect(read.parameters.required).not.toContain("path");
    expect(read.parameters.properties.fileId).toBeTruthy();
    const output = await read.execute("call-fileid", {
      fileId: "sf_cjk_digits",
    });

    expect(output.details.params.path).toBe("/work/测试123/报告2026.txt");
    expect(output.details.params.fileId).toBe("sf_cjk_digits");
  });
});
