import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodiaEngine } from "../core/engine.js";

describe("CodiaEngine.buildTools", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("throws when opts.agentDir points at an unknown agent instead of using focus tools", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-build-tools-"));
    const focusAgentDir = path.join(tmpDir, "agents", "focus");
    const missingAgentDir = path.join(tmpDir, "agents", "missing");

    const engine = Object.create(CodiaEngine.prototype);
    engine.codiaHome = tmpDir;
    engine.getAgent = vi.fn(() => null);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir: focusAgentDir,
        tools: [{ name: "focus_custom_tool", execute: vi.fn() }],
      },
    };

    expect(() => engine.buildTools(tmpDir, undefined, {
      agentDir: missingAgentDir,
      workspace: tmpDir,
    })).toThrow(/agent "missing" not found/);
  });

  it("uses an explicit permission mode provider instead of the desktop session default", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-build-tools-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const sessionPath = path.join(tmpDir, "sessions", "bridge.jsonl");
    const execute = vi.fn(async () => ({ details: { executed: true } }));
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };

    const engine = Object.create(CodiaEngine.prototype);
    engine.codiaHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = confirmStore;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "ask");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [
      { name: "stage_files", execute },
    ], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    const result = await customTools[0].execute(
      "call-1",
      { path: "x" },
      { sessionManager: { getSessionFile: () => sessionPath } },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("passes a session workbench execution boundary into plugin tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-build-tools-boundary-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(CodiaEngine.prototype);
    engine.codiaHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        execute,
      }],
    };
    engine._pluginDevService = null;
    engine._prefs = {
      getFileBackup: () => ({ enabled: false }),
      getChannelsEnabled: () => true,
    };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");

    await pluginTool.execute("call-1", { ok: true }, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(execute).toHaveBeenCalledWith("call-1", { ok: true }, expect.objectContaining({
      agentId: "focus",
      serverNodeId: "node_engine",
      executionBoundary: expect.objectContaining({
        boundaryId: "execb_node_engine_studio_engine",
        serverNodeId: "node_engine",
        studioId: "studio_engine",
        workbench: {
          kind: "legacy_agent_workbench",
          root: workspace,
        },
      }),
    }));
  });

  it("registers files created or modified by write and edit tools in the active session", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-build-tools-touch-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "touch.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, operation }) => ({
      id: `sf_${operation}`,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
    }));
    const engine = Object.create(CodiaEngine.prototype);
    engine.codiaHome = tmpDir;
    engine.registerSessionFile = registerSessionFile;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-1", { path: "draft.md", content: "hello\n" });
    const editResult = await edit.execute("edit-1", {
      path: "draft.md",
      edits: [{ oldText: "hello", newText: "hello Codia" }],
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "draft.md"),
      label: "draft.md",
      origin: "agent_write",
      operation: "created",
    }));
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "draft.md"),
      label: "draft.md",
      origin: "agent_edit",
      operation: "modified",
    }));
    expect(writeResult.details.sessionFile).toMatchObject({
      id: "sf_created",
      filePath: path.join(workspace, "draft.md"),
      origin: "agent_write",
    });
    expect(editResult.details.sessionFile).toMatchObject({
      id: "sf_modified",
      filePath: path.join(workspace, "draft.md"),
      origin: "agent_edit",
    });
  });

  it("normalizes write/edit file_path aliases before SDK execution and session file registration", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-build-tools-touch-alias-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "touch-alias.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, operation }) => ({
      id: `sf_${origin}_${operation}`,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
    }));
    const engine = Object.create(CodiaEngine.prototype);
    engine.codiaHome = tmpDir;
    engine.registerSessionFile = registerSessionFile;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-alias-1", {
      file_path: "alias.md",
      content: "hello\n",
    });
    const editResult = await edit.execute("edit-alias-1", {
      filePath: "alias.md",
      edits: [{ oldText: "hello", newText: "hello aliases" }],
    });

    expect(fs.readFileSync(path.join(workspace, "alias.md"), "utf8")).toBe("hello aliases\n");
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "alias.md"),
      label: "alias.md",
      origin: "agent_write",
      operation: "created",
    }));
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "alias.md"),
      label: "alias.md",
      origin: "agent_edit",
      operation: "modified",
    }));
    expect(writeResult.details.sessionFile).toMatchObject({
      filePath: path.join(workspace, "alias.md"),
      origin: "agent_write",
    });
    expect(editResult.details.sessionFile).toMatchObject({
      filePath: path.join(workspace, "alias.md"),
      origin: "agent_edit",
    });
  });
});
