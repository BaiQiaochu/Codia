import { describe, expect, it } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const root = process.cwd();

describe("server transport ownership", () => {
  it("binds the server endpoint before first-run, engine init, plugins, and schedulers", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    const bindIndex = source.indexOf("await bindServerTransportOwnership");
    expect(bindIndex).toBeGreaterThan(-1);
    expect(bindIndex).toBeLessThan(source.indexOf("ensureFirstRun("));
    expect(bindIndex).toBeLessThan(source.indexOf("new CodiaEngine("));
    expect(bindIndex).toBeLessThan(source.indexOf("await engine.init("));
    expect(bindIndex).toBeLessThan(source.indexOf("await engine.initPlugins("));
    expect(bindIndex).toBeLessThan(source.indexOf("hub.initSchedulers()"));
  });

  it("reports PORT_IN_USE with host, port, network mode, and recovery suggestions", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(source).toContain("code: \"PORT_IN_USE\"");
    expect(source).toContain("networkMode");
    expect(source).toContain("suggestions");
    expect(source).toContain("startup-error");
  });

  it("registers compaction framework extensions before plugin startup lifecycles", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    const compactionIndex = source.indexOf("await engine.registerExtensionFactory(createCompactionGuardExtension");
    expect(compactionIndex).toBeGreaterThan(-1);
    expect(compactionIndex).toBeLessThan(source.indexOf("await engine.initPlugins("));
  });

  it("uses the configured server network host as the transport bind host", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(source).toContain("const host = serverNetwork.host");
    expect(source).toContain("hostname: host");
    expect(source).not.toContain("hostname: \"0.0.0.0\"");
  });

  it("reports LISTEN_PERMISSION_DENIED for EACCES listen failures", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(source).toContain("code: \"LISTEN_PERMISSION_DENIED\"");
    expect(source).toContain("isListenPermissionError");
    expect(source).toContain("EACCES");
  });

  it.skipIf(!fs.existsSync(path.join(root, "core", "engine.js")))(
    "exits on port conflict before first-run or engine initialization",
    async () => {
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve as any);
    });
    const port = (blocker.address() as any).port;
    const codiaHome = fs.mkdtempSync(path.join(os.tmpdir(), "codia-port-conflict-test-"));
    const child = spawn(process.execPath, ["server/bootstrap.ts"], {
      cwd: root,
      env: {
        ...process.env,
        CODIA_HOME: codiaHome,
        CODIA_PORT: String(port),
        CODIA_ROOT: root,
        CODIA_SERVER_ENTRY: path.join(root, "server", "index.ts"),
        CODIA_CREATE_STARTUP_SESSION: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    try {
      const result = await Promise.race([
        new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal }))),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 10_000)),
      ]);
      if ((result as any).timeout) {
        child.kill("SIGKILL");
      }

      expect(result).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("PORT_IN_USE");
      expect(stdout + stderr).not.toContain("ensureFirstRun");
      expect(stdout + stderr).not.toContain("CodiaEngine");
    } finally {
      blocker.close();
      fs.rmSync(codiaHome, { recursive: true, force: true });
    }
    },
  );
});
