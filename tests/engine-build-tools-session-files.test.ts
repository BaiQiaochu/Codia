// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createSandboxedTools = vi.fn(() => ({ tools: [], customTools: [] }));

vi.mock("../lib/sandbox/index.js", () => ({
  createSandboxedTools,
}));

const { GsapEngine } = await import("../core/engine.js");

describe("GsapEngine.buildTools session external sandbox grants", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
    vi.clearAllMocks();
  });

  it("passes active session external files as read-only sandbox inputs", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-sandbox-files-"));
    const hanakoHome = path.join(tempRoot, "gsap-home");
    const agentDir = path.join(hanakoHome, "agents", "hana");
    const workspace = path.join(tempRoot, "workspace");
    const externalFile = path.join(tempRoot, "outside", "brief.md");
    const workspaceFile = path.join(workspace, "owned.md");
    const managedFile = path.join(hanakoHome, "session-files", "shot.png");
    for (const file of [externalFile, workspaceFile, managedFile]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
    fs.mkdirSync(agentDir, { recursive: true });
    const sessionPath = path.join(agentDir, "sessions", "one.jsonl");

    const engine = Object.create(GsapEngine.prototype);
    engine.hanakoHome = hanakoHome;
    engine.getAgent = vi.fn(() => ({ id: "hana", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine.registerSessionFile = vi.fn();
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
    engine._agentMgr = { agent: { id: "hana", agentDir, tools: [] } };
    engine.listSessionFiles = vi.fn(() => [
      { filePath: externalFile, realPath: fs.realpathSync(externalFile), storageKind: "external", status: "available" },
      { filePath: workspaceFile, realPath: fs.realpathSync(workspaceFile), storageKind: "external", status: "available" },
      { filePath: managedFile, realPath: fs.realpathSync(managedFile), storageKind: "managed_cache", status: "available" },
    ]);

    engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });

    const sandboxOpts = createSandboxedTools.mock.calls[0][2];
    expect(sandboxOpts.getExternalReadPaths()).toEqual([fs.realpathSync(externalFile)]);
    expect(sandboxOpts.getSessionPath()).toBe(sessionPath);
    expect(typeof sandboxOpts.recordFileOperation).toBe("function");
    expect(sandboxOpts.getVisionBridge()).toBeNull();
  });

  it("passes the sandbox network preference as a dynamic sandbox option", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-sandbox-network-"));
    const hanakoHome = path.join(tempRoot, "gsap-home");
    const agentDir = path.join(hanakoHome, "agents", "hana");
    const workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const engine = Object.create(GsapEngine.prototype);
    engine.hanakoHome = hanakoHome;
    engine.getAgent = vi.fn(() => ({ id: "hana", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    let prefs = { sandbox: true, sandbox_network: true };
    engine._readPreferences = () => prefs;
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine.registerSessionFile = vi.fn();
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
    engine._agentMgr = { agent: { id: "hana", agentDir, tools: [] } };
    engine.listSessionFiles = vi.fn(() => []);

    engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => null,
    });

    const sandboxOpts = createSandboxedTools.mock.calls.at(-1)[2];
    expect(sandboxOpts.getSandboxNetworkEnabled()).toBe(true);
    if (process.platform !== "win32") {
      prefs = { sandbox: true, sandbox_network: false };
      expect(sandboxOpts.getSandboxNetworkEnabled()).toBe(false);
    }
  });

  it("passes dynamic session-authorized folders into sandbox construction", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-authorized-folders-"));
    const hanakoHome = path.join(tempRoot, "gsap-home");
    const agentDir = path.join(hanakoHome, "agents", "gsap");
    const workspace = path.join(tempRoot, "workspace");
    const authorized = path.join(tempRoot, "external-assets");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(authorized, { recursive: true });

    const engine = Object.create(GsapEngine.prototype);
    engine.gsapHome = hanakoHome;
    engine.getAgent = vi.fn(() => ({ id: "gsap", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine.registerSessionFile = vi.fn();
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
    engine._agentMgr = { agent: { id: "gsap", agentDir, tools: [] } };
    engine.listSessionFiles = vi.fn(() => []);

    engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      authorizedFolders: [],
      getAuthorizedFolders: () => [authorized],
      getSessionPath: () => path.join(agentDir, "sessions", "one.jsonl"),
    });

    const sandboxOpts = createSandboxedTools.mock.calls.at(-1)[2];
    expect(sandboxOpts.authorizedFolders).toEqual([]);
    expect(sandboxOpts.getAuthorizedFolders()).toEqual([authorized]);
    expect(sandboxOpts.getExternalReadPaths()).toEqual([]);
  });

  it("keeps Windows restricted-token command sandbox networking enabled at the tool boundary", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-win32-sandbox-network-"));
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      const hanakoHome = path.join(tempRoot, "gsap-home");
      const agentDir = path.join(hanakoHome, "agents", "hana");
      const workspace = path.join(tempRoot, "workspace");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });

      const engine = Object.create(GsapEngine.prototype);
      engine.hanakoHome = hanakoHome;
      engine.getAgent = vi.fn(() => ({ id: "hana", agentDir, tools: [] }));
      engine._pluginManager = null;
      engine._prefs = { getFileBackup: () => ({ enabled: false }) };
      engine._readPreferences = () => ({ sandbox: true, sandbox_network: false });
      engine._confirmStore = null;
      engine._emitEvent = vi.fn();
      engine.getSessionPermissionMode = vi.fn(() => "operate");
      engine.registerSessionFile = vi.fn();
      engine.getVisionBridge = vi.fn(() => null);
      engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
      engine._agentMgr = { agent: { id: "hana", agentDir, tools: [] } };
      engine.listSessionFiles = vi.fn(() => []);

      engine.buildTools(workspace, [], {
        agentDir,
        workspace,
        getSessionPath: () => path.join(agentDir, "sessions", "one.jsonl"),
      });

      const sandboxOpts = createSandboxedTools.mock.calls.at(-1)[2];
      expect(sandboxOpts.getSandboxNetworkEnabled()).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("rejects disabling sandbox networking through GsapEngine on Windows", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      const engine = Object.create(GsapEngine.prototype);
      engine._prefs = {
        getSandboxNetwork: vi.fn(() => false),
        setSandboxNetwork: vi.fn(),
      };

      expect(engine.getSandboxNetwork()).toBe(true);
      expect(() => engine.setSandboxNetwork(false)).toThrow("does not support network isolation");
      expect(engine._prefs.setSandboxNetwork).not.toHaveBeenCalled();
      engine.setSandboxNetwork(true);
      expect(engine._prefs.setSandboxNetwork).toHaveBeenCalledWith(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("includes inherited parent session files in read-only sandbox inputs", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-sandbox-parent-files-"));
    const hanakoHome = path.join(tempRoot, "gsap-home");
    const agentDir = path.join(hanakoHome, "agents", "hana");
    const workspace = path.join(tempRoot, "workspace");
    const childExternal = path.join(tempRoot, "outside", "child.md");
    const parentExternal = path.join(tempRoot, "outside", "parent.md");
    const parentWorkspaceFile = path.join(workspace, "owned-by-workspace.md");
    for (const file of [childExternal, parentExternal, parentWorkspaceFile]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
    fs.mkdirSync(agentDir, { recursive: true });
    const childSessionPath = path.join(agentDir, "subagent-sessions", "child.jsonl");
    const parentSessionPath = path.join(agentDir, "sessions", "parent.jsonl");

    const engine = Object.create(GsapEngine.prototype);
    engine.hanakoHome = hanakoHome;
    engine.getAgent = vi.fn(() => ({ id: "hana", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine.registerSessionFile = vi.fn();
    engine.getVisionBridge = vi.fn(() => null);
    engine.isVisionAuxiliaryEnabled = vi.fn(() => false);
    engine._agentMgr = { agent: { id: "hana", agentDir, tools: [] } };
    engine.listSessionFiles = vi.fn((sessionPath) => {
      if (sessionPath === childSessionPath) {
        return [
          { filePath: childExternal, realPath: fs.realpathSync(childExternal), storageKind: "external", status: "available" },
        ];
      }
      if (sessionPath === parentSessionPath) {
        return [
          { filePath: parentExternal, realPath: fs.realpathSync(parentExternal), storageKind: "external", status: "available" },
          { filePath: parentWorkspaceFile, realPath: fs.realpathSync(parentWorkspaceFile), storageKind: "external", status: "available" },
        ];
      }
      return [];
    });

    engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => childSessionPath,
      fileReadSessionPaths: [parentSessionPath],
    });

    const sandboxOpts = createSandboxedTools.mock.calls[0][2];
    expect(sandboxOpts.getExternalReadPaths()).toEqual([
      fs.realpathSync(childExternal),
      fs.realpathSync(parentExternal),
    ]);
  });
});
