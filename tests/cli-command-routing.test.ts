import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { dispatchCliCommand, normalizeCommandName } from "../lib/cli/commands.ts";

describe("CLI command routing", () => {
  it("normalizes Codex-style and legacy aliases", () => {
    expect(normalizeCommandName("run")).toBe("exec");
    expect(normalizeCommandName("status")).toBe("health");
    expect(normalizeCommandName("send")).toBe("chat");
    expect(normalizeCommandName("exec")).toBe("exec");
    expect(normalizeCommandName("repl")).toBe("interactive");
    expect(normalizeCommandName("session")).toBe("sessions");
    expect(normalizeCommandName("model")).toBe("models");
    expect(normalizeCommandName("cmds")).toBe("commands");
    expect(normalizeCommandName("serve")).toBe("serve");
    expect(normalizeCommandName("server")).toBe("serve");
  });

  it("routes config through the dedicated config handler", async () => {
    const handlers = {
      commandConfig: vi.fn(async () => "config-ok"),
    };

    await expect(dispatchCliCommand({}, "config", ["list"], {}, handlers)).resolves.toBe("config-ok");
    expect(handlers.commandConfig).toHaveBeenCalledWith({}, ["list"], {});
  });

  it("routes run, exec, and resume through dedicated handlers", async () => {
    const handlers = {
      commandExec: vi.fn(async () => "exec-ok"),
      commandResume: vi.fn(async () => "resume-ok"),
    };
    const client = {};
    const opts = { json: false };

    await expect(dispatchCliCommand(client, "run", ["hello"], opts, handlers)).resolves.toBe("exec-ok");
    await expect(dispatchCliCommand(client, "exec", ["hello"], opts, handlers)).resolves.toBe("exec-ok");
    await expect(dispatchCliCommand(client, "resume", ["abc"], opts, handlers)).resolves.toBe("resume-ok");

    expect(handlers.commandExec).toHaveBeenNthCalledWith(1, client, ["hello"], opts);
    expect(handlers.commandExec).toHaveBeenNthCalledWith(2, client, ["hello"], opts);
    expect(handlers.commandResume).toHaveBeenCalledWith(client, ["abc"], opts);
  });

  it("routes doctor to diagnostics", async () => {
    const handlers = {
      commandDoctor: vi.fn(async () => "doctor-ok"),
    };

    await expect(dispatchCliCommand({}, "doctor", [], {}, handlers)).resolves.toBe("doctor-ok");
    expect(handlers.commandDoctor).toHaveBeenCalledWith({}, [], {});
  });

  it("routes serve to the foreground server handler", async () => {
    const handlers = {
      commandServe: vi.fn(async () => "serve-ok"),
    };

    await expect(dispatchCliCommand({}, "serve", ["--host", "127.0.0.1"], {}, handlers)).resolves.toBe("serve-ok");
    await expect(dispatchCliCommand({}, "server", [], {}, handlers)).resolves.toBe("serve-ok");
    expect(handlers.commandServe).toHaveBeenNthCalledWith(1, {}, ["--host", "127.0.0.1"], {});
    expect(handlers.commandServe).toHaveBeenNthCalledWith(2, {}, [], {});
  });

  it("routes permissions to the permission handler", async () => {
    const handlers = {
      commandPermissions: vi.fn(async () => "permissions-ok"),
    };

    await expect(dispatchCliCommand({}, "permissions", ["get"], {}, handlers)).resolves.toBe("permissions-ok");
    expect(handlers.commandPermissions).toHaveBeenCalledWith({}, ["get"], {});
  });

  it("publishes codia as the formal CLI command while keeping compatibility aliases", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));

    expect(pkg.bin).toMatchObject({
      codia: "scripts/codiactl.mjs",
      "codia-cli": "scripts/codiactl.mjs",
      codiactl: "scripts/codiactl.mjs",
    });
  });

  it("prints version without connecting to the server", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    const version = execFileSync(process.execPath, ["index.js", "--version"], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1", CODIA_SERVER_INFO: path.join(process.cwd(), "missing-server-info-for-version.json") },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    expect(version).toBe(pkg.version);
  });

  it("routes npm cli launcher through the maintained codiactl entry", () => {
    const launchScript = fs.readFileSync(path.join(process.cwd(), "scripts", "launch.js"), "utf-8");

    expect(launchScript).toContain("scripts/codiactl.mjs");
    expect(launchScript).not.toContain('args = ["index.js"');
  });

  it("keeps the package root entry as a lightweight CLI wrapper", () => {
    const entryScript = fs.readFileSync(path.join(process.cwd(), "index.js"), "utf-8");

    expect(entryScript).toContain("runCliMain");
    expect(entryScript).toContain("./lib/cli/main.ts");
    expect(entryScript).not.toContain("./core/engine.js");
  });
});
