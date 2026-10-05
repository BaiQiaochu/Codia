import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("connection CSP bootstrap", () => {
  it("uses the G-SAP connection store and stays loaded before renderer modules", () => {
    const html = fs.readFileSync(path.join(root, "desktop/src/index.html"), "utf8");
    const csp = fs.readFileSync(path.join(root, "desktop/src/modules/connection-csp.ts"), "utf8");

    expect(html).toContain('<script src="modules/connection-csp.js"></script>');
    expect(html.indexOf("modules/connection-csp.js")).toBeLessThan(html.indexOf("./main.tsx"));
    expect(fs.existsSync(path.join(root, "desktop/src/modules/connection-csp.js"))).toBe(false);
    expect(csp).toContain("gsap-server-connections-v1");
    expect(csp).toContain("hana-server-connections-v1");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("ws://127.0.0.1:*");
  });
});
