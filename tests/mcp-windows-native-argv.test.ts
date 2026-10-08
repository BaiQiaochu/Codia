import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveMcpStdioSpawnSpec } from "../plugins/mcp/lib/mcp-stdio-client.js";

// A separate, harmless native gate. On other platforms none of the fixture
// files/processes are created. These results must not be inferred from the
// cross-platform launch-planning tests.
describe.runIf(process.platform === "win32")("native Windows MCP argv fixture", () => {
  it.each(["exe", "cmd", "bat", "npm-style-shim"])("records actual argv for %s without network or registry access", (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-mcp argv-"));
    try {
      const recorder = path.join(dir, "record-argv.cjs");
      fs.writeFileSync(recorder, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), registry: process.env.NPM_CONFIG_REGISTRY }));\n");
      const args = [
        "", "plain", "two words", "中文 café", "https://example.invalid/?a=one&b=two",
        "report&archive", "A|B", "caret^literal", "(group)", "%PATH%", "!VALUE!",
        'say "hello"', `two${"\\".repeat(2)}"slashes`, "C:\\Program Files\\fixture\\", "",
      ];
      let command = process.execPath;
      let launchArgs = [recorder, ...args];
      if (kind !== "exe") {
        const folder = kind === "npm-style-shim" ? path.join(dir, "node_modules", ".bin") : dir;
        fs.mkdirSync(folder, { recursive: true });
        command = path.join(folder, kind === "bat" ? "record.bat" : "record.cmd");
        // Ordinary one-line forwarding versus a compound endlocal forwarding
        // line (the extra parse layer used by npm-generated .bin shims).
        const body = kind === "npm-style-shim"
          ? `@echo off\r\nsetlocal\r\nset "MCP_FIXTURE_NODE=${process.execPath}"\r\nendlocal & "%MCP_FIXTURE_NODE%" "${recorder}" %*\r\n`
          : `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`;
        fs.writeFileSync(command, body);
        launchArgs = args;
      }
      const spec = resolveMcpStdioSpawnSpec({
        command, args: launchArgs,
        registryUrl: "https://registry.example.invalid",
        env: { PI_OFFLINE: "1", VALUE: "must-stay-literal" },
      });
      const result = spawnSync(spec.command, spec.args, {
        env: spec.env, shell: false, windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
        encoding: "utf8", timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ args, registry: "https://registry.example.invalid" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
