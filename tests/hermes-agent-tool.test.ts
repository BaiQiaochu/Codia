// @ts-nocheck
import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  buildHermesUnavailableResult,
  buildHermesEnv,
  buildHermesLaunchPayload,
  classifyHermesFailure,
  createHermesAgentTool,
  normalizeHermesApiMode,
  normalizeHermesModel,
  normalizeHermesProvider,
  resetHermesUnavailableStateForTests,
  resolveHermesAgentRoot,
  resolveHermesGitBashPath,
  resolveHermesPythonCandidates,
} from "../lib/tools/hermes-agent-tool.js";

describe("hermes agent tool normalization", () => {
  it("maps Codia provider aliases to Hermes provider ids", () => {
    expect(normalizeHermesProvider("kimi-coding")).toBe("kimi-for-coding");
    expect(normalizeHermesProvider("moonshot")).toBe("kimi-for-coding");
    expect(normalizeHermesProvider("minimax")).toBe("minimax");
    expect(normalizeHermesProvider("deepseek")).toBe("deepseek");
  });

  it("maps Codia api names to Hermes api modes", () => {
    expect(normalizeHermesApiMode("openai-completions")).toBe("chat_completions");
    expect(normalizeHermesApiMode("openai-responses")).toBe("codex_responses");
    expect(normalizeHermesApiMode("anthropic-messages")).toBe("anthropic_messages");
  });

  it("normalizes object-shaped model refs into Hermes-safe strings", () => {
    expect(normalizeHermesModel({ id: "deepseek-v4-pro", provider: "deepseek" })).toBe("deepseek-v4-pro");
    expect(normalizeHermesModel({
      model: { id: "claude-sonnet-4.6", provider: "anthropic" },
      provider: "anthropic",
    })).toBe("claude-sonnet-4.6");
    expect(normalizeHermesModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("prefers an actual Git Bash path over Windows bash shims", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-bash-"));
    const bashPath = path.join(tempDir, "vendor", "git-portable", "bin", "bash.exe");
    fs.mkdirSync(path.dirname(bashPath), { recursive: true });
    fs.writeFileSync(bashPath, "");

    expect(resolveHermesGitBashPath({
      env: {
        ProgramFiles: "Z:\\missing",
        "ProgramFiles(x86)": "Z:\\missing-x86",
        LOCALAPPDATA: "Z:\\missing-local",
      },
      resourcesPath: "",
      cwd: tempDir,
    })).toBe(path.resolve(bashPath));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the bundled MinGit busybox shell when bash.exe is not present", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-ash-"));
    const ashPath = path.join(tempDir, "vendor", "git-portable", "mingw64", "bin", "ash.exe");
    fs.mkdirSync(path.dirname(ashPath), { recursive: true });
    fs.writeFileSync(ashPath, "");

    expect(resolveHermesGitBashPath({
      env: {
        ProgramFiles: "Z:\\missing",
        "ProgramFiles(x86)": "Z:\\missing-x86",
        LOCALAPPDATA: "Z:\\missing-local",
      },
      resourcesPath: "",
      cwd: tempDir,
    })).toBe(path.resolve(ashPath));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves the bundled Hermes runtime from CODIA_ROOT", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-runtime-"));
    const runtimeRoot = path.join(tempDir, "hermes-agent-runtime");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "run_agent.py"), "");

    expect(resolveHermesAgentRoot({
      env: { CODIA_ROOT: tempDir },
      resourcesPath: "",
      cwd: path.join(tempDir, "missing"),
    })).toBe(path.resolve(runtimeRoot));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not use system Python by default", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-python-"));
    const portablePython = path.join(tempDir, "python", process.platform === "win32" ? "python.exe" : "bin/python");
    const venvPython = path.join(tempDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    fs.mkdirSync(path.dirname(portablePython), { recursive: true });
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.writeFileSync(portablePython, "");
    fs.writeFileSync(venvPython, "");

    const commands = resolveHermesPythonCandidates(tempDir, { env: {} })
      .map((candidate) => candidate.command);

    expect(commands).toContain(portablePython);
    expect(commands).toContain(venvPython);
    expect(commands).not.toContain("uv");
    expect(commands).not.toContain("py");
    expect(commands).not.toContain("python");
    expect(commands).not.toContain("python3");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("only allows system Python when explicitly enabled", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-python-system-"));
    const candidates = resolveHermesPythonCandidates(tempDir, {
      env: { HERMES_ALLOW_SYSTEM_PYTHON: "1" },
    });
    const commands = candidates.map((candidate) => candidate.command);

    expect(commands).toContain("uv");
    expect(commands).toContain("py");
    expect(commands).toContain("python");
    expect(commands).toContain("python3");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("enables Hermes file and terminal toolsets by default", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-cwd-"));

    try {
      const payload = buildHermesLaunchPayload({ prompt: "inspect files", cwd: tempDir });

      expect(payload.cwd).toBe(path.resolve(tempDir));
      expect(payload.enabled_toolsets).toContain("file");
      expect(payload.enabled_toolsets).toContain("terminal");
      expect(payload.enabled_toolsets).toContain("todo");
      expect(payload.enabled_toolsets).toContain("memory");
      expect(payload.enabled_toolsets).toContain("skills");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps caller-provided Hermes toolsets when explicitly supplied", () => {
    const payload = buildHermesLaunchPayload({
      prompt: "limited run",
      enabled_toolsets: ["memory", "skills", "memory", ""],
      disabled_toolsets: ["browser", "", "browser"],
    });

    expect(payload.enabled_toolsets).toEqual(["memory", "skills"]);
    expect(payload.disabled_toolsets).toEqual(["browser"]);
  });

  it("configures the Hermes Windows terminal backend for local file and shell access", () => {
    const previousEnv = {
      TERMINAL_ENV: process.env.TERMINAL_ENV,
      TERMINAL_CWD: process.env.TERMINAL_CWD,
      TERMINAL_LOCAL_PERSISTENT: process.env.TERMINAL_LOCAL_PERSISTENT,
      TERMINAL_TIMEOUT: process.env.TERMINAL_TIMEOUT,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-hermes-env-"));

    try {
      process.env.TERMINAL_ENV = "docker";
      delete process.env.TERMINAL_CWD;
      delete process.env.TERMINAL_LOCAL_PERSISTENT;
      delete process.env.TERMINAL_TIMEOUT;

      const env = buildHermesEnv({ cwd: tempDir }, process.cwd());

      if (process.platform === "win32") {
        expect(env.TERMINAL_ENV).toBe("local");
        expect(env.TERMINAL_CWD).toBe(path.resolve(tempDir));
        expect(env.TERMINAL_LOCAL_PERSISTENT).toBe("true");
        expect(env.TERMINAL_TIMEOUT).toBe("180");
      } else {
        expect(env.TERMINAL_CWD).toBe(path.resolve(tempDir));
      }
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a recoverable unavailable result when the Hermes runtime is missing", async () => {
    resetHermesUnavailableStateForTests();

    const previousEnv = {
      HERMES_AGENT_ROOT: process.env.HERMES_AGENT_ROOT,
      CODIA_ROOT: process.env.CODIA_ROOT,
      HERMES_ALLOW_DEV_RUNTIME: process.env.HERMES_ALLOW_DEV_RUNTIME,
      NODE_ENV: process.env.NODE_ENV,
    };

    try {
      process.env.HERMES_AGENT_ROOT = path.join(os.tmpdir(), `missing-hermes-runtime-${Date.now()}`);
      delete process.env.CODIA_ROOT;
      delete process.env.HERMES_ALLOW_DEV_RUNTIME;
      process.env.NODE_ENV = "test";

      const tool = createHermesAgentTool();
      const result = await tool.execute("call-1", { task: "write a manual" });
      const text = result.content[0].text;

      expect(text).toContain("Hermes Agent is unavailable");
      expect(text).toContain("Continue this request without Hermes");
      expect(result.details.unavailable).toBe(true);
      expect(result.details.category).toBe("runtime");
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetHermesUnavailableStateForTests();
    }
  });

  it("classifies bridge and sandbox backend failures as unavailable", () => {
    const failure = classifyHermesFailure("RuntimeError: sandbox backend bridge failed");
    expect(failure.category).toBe("bridge");
    expect(failure.tripCircuit).toBe(true);

    const result = buildHermesUnavailableResult("RuntimeError: sandbox backend bridge failed", {
      prompt: "我自己写这本手册，不经过 Hermes",
    });
    const text = result.content[0].text;

    expect(text).toContain("Hermes Agent 当前不可用");
    expect(text).toContain("本次请求请不要继续调用 hermes_agent");
    expect(result.details.category).toBe("bridge");
  });
});
