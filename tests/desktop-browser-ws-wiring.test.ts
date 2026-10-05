import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = () => fs.readFileSync(path.resolve("desktop", "main.cjs"), "utf8");

describe("desktop browser control WebSocket wiring", () => {
  it("connects Electron browser commands after server start and restart", () => {
    const main = source();

    expect(main.match(/setupBrowserCommands\(\);/g)).toHaveLength(3);
    expect(main).toContain("function teardownBrowserCommands()");
    expect(main).toContain("let browserCommandGeneration = 0;");
    expect(main).toContain("teardownBrowserCommands();\n  const generation = browserCommandGeneration;");
    expect(main).toContain("browserCommandReconnectTimer = setTimeout(connect, 2000);");
  });
});
