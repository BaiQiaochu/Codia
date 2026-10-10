import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("bridge owner tool policy", () => {
  it("keeps desktop-only card tools out of bridge owner sessions", () => {
    const source = readSource("core/bridge-session-manager.ts");

    expect(source).toContain('"codia_card_guide"');
    expect(source).toContain('"show_card"');
    expect(source).toContain("function filterBridgeOwnerToolObjects");
    expect(source).toContain("const ownerTools = filterBridgeOwnerToolObjects(bridgeTools)");
    expect(source).toContain("const ownerCustomTools = filterBridgeOwnerToolObjects(bridgeCustomTools)");
    expect(source).toContain("tools: ownerTools");
    expect(source).toContain("customTools: ownerCustomTools");
  });
});
