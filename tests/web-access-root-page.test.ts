import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("web access root page wiring", () => {
  it("keeps the unauthenticated root path on an informational HTML page instead of forbidden JSON", () => {
    const serverEntry = fs.existsSync(path.join(process.cwd(), "server", "index.ts"))
      ? path.join(process.cwd(), "server", "index.ts")
      : path.join(process.cwd(), "server", "index.js");
    const source = fs.readFileSync(serverEntry, "utf8");

    expect(source).toContain("function isPublicAccessInfoRequest(c)");
    expect(source).toContain('url.pathname === "/"');
    expect(source).toContain("function renderAccessInfoPage()");
    expect(source).toContain('c.header("Content-Type", "text/html; charset=utf-8")');
    expect(source).toContain("return c.html(renderAccessInfoPage())");

    const publicCheckIdx = source.indexOf("if (isPublicAccessInfoRequest(c))");
    const forbiddenIdx = source.indexOf("if (!resolvedPrincipal.ok)");
    expect(publicCheckIdx).toBeGreaterThan(-1);
    expect(forbiddenIdx).toBeGreaterThan(-1);
    expect(publicCheckIdx).toBeLessThan(forbiddenIdx);
  });
});
