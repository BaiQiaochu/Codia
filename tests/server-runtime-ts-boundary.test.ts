import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { resolveServerLaunchConfig } = require("../desktop/server-runtime.cjs");

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-ts-runtime-"));
  for (const relativePath of files) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "", "utf8");
  }
  return root;
}

describe("server runtime TypeScript boundary", () => {
  it("uses source JavaScript while server/index.js is present", () => {
    const root = makeProject(["server/index.js", "server/bootstrap.js"]);
    const config = resolveServerLaunchConfig({
      env: { GSAP_LAUNCH_NODE: process.execPath },
      projectRoot: root,
      resourcesPath: "",
      platform: process.platform,
      arch: process.arch,
      electronExecPath: process.execPath,
    });

    expect(config.kind).toBe("dev-source-node");
    expect(config.serverEnv.GSAP_SERVER_ENTRY.endsWith(path.join("server", "index.js"))).toBe(true);
  });

  it("uses TypeScript source directly when the launch Node supports it", () => {
    const root = makeProject(["server/index.ts", "server/bootstrap.ts"]);
    const config = resolveServerLaunchConfig({
      env: { GSAP_LAUNCH_NODE: process.execPath, GSAP_LAUNCH_NODE_VERSION: "24.14.0" },
      projectRoot: root,
      resourcesPath: "",
      platform: process.platform,
      arch: process.arch,
      electronExecPath: process.execPath,
    });

    expect(config.kind).toBe("dev-source-node");
    expect(config.serverArgs).toEqual([path.join(root, "server", "bootstrap.ts")]);
    expect(config.serverEnv.GSAP_SERVER_ENTRY.endsWith(path.join("server", "index.ts"))).toBe(true);
  });

  it("does not choose raw TypeScript source before Node 24", () => {
    const root = makeProject(["server/index.ts", "server/bootstrap.ts"]);
    const config = resolveServerLaunchConfig({
      env: { GSAP_LAUNCH_NODE: process.execPath, GSAP_LAUNCH_NODE_VERSION: "22.16.0" },
      projectRoot: root,
      resourcesPath: "",
      platform: process.platform,
      arch: process.arch,
      electronExecPath: process.execPath,
    });

    expect(config.kind).not.toBe("dev-source-node");
    expect(config.serverEnv.GSAP_SERVER_ENTRY.endsWith(path.join("server", "index.ts"))).toBe(false);
  });

  it("rejects raw TypeScript bootstrap entries before Node 24", async () => {
    const { assertSupportedServerEntry } = await import("../server/bootstrap-guard.ts");

    expect(() => assertSupportedServerEntry("server/index.ts", "22.16.0")).toThrow(
      "TypeScript source entry requires Node 24",
    );
    expect(() => assertSupportedServerEntry("server/index.ts", "24.12.0")).not.toThrow();
    expect(() => assertSupportedServerEntry("dist-server-bundle/index.js", "22.16.0")).not.toThrow();
  });
});
