import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { ResourceAccessPolicy } from "../lib/resource-io/resource-access-policy.ts";

describe("ResourceAccessPolicy boundary", () => {
  it("returns typed denial details for protected metadata writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-authority-"));
    const policy = new ResourceAccessPolicy({
      cwd: root,
      agentDir: path.join(root, "agent"),
      workspace: root,
      workspaceFolders: [root],
      gsapHome: path.join(root, ".gsap"),
      getSandboxEnabled: () => true,
    });

    const protectedPath = path.join(root, ".git", "config");
    const result = policy.check(protectedPath, "write");

    expect(result).toMatchObject({
      allowed: false,
      code: "protected_metadata",
      safeMessage: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(protectedPath);
  });

  it("keeps PathGuard internal to ResourceAccessPolicy for ResourceIO code", () => {
    const productionHits = findProductionImports("PathGuard");
    expect(productionHits).toEqual([
      "lib/resource-io/resource-access-policy.ts",
    ]);
  });
});

function findProductionImports(symbol: string): string[] {
  const root = path.join(process.cwd(), "lib", "resource-io");
  const hits: string[] = [];
  visit(root);
  return hits.sort();

  function visit(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const text = fs.readFileSync(fullPath, "utf-8");
      if (text.includes(symbol)) hits.push(path.relative(process.cwd(), fullPath).replace(/\\/g, "/"));
    }
  }
}
