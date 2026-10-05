import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PWA_DISPLAY_NAME } from "../shared/product-branding.ts";

const root = process.cwd();

describe("PWA branding contract", () => {
  it("uses the requested PWA display name in manifest and document title", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "desktop", "src", "mobile-manifest.webmanifest"), "utf-8"),
    );
    const html = fs.readFileSync(path.join(root, "desktop", "src", "mobile.html"), "utf-8");

    expect(manifest.name).toBe(PWA_DISPLAY_NAME);
    expect(manifest.short_name).toBe("Codia");
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "./icon.png", sizes: "512x512", type: "image/png" }),
    ]));
    expect(html).toContain(`<title>${PWA_DISPLAY_NAME}</title>`);
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest">');
  });

  it("uses the same display name in the mobile shell text", () => {
    const entry = fs.readFileSync(path.join(root, "desktop", "src", "mobile-main.tsx"), "utf-8");
    const app = fs.readFileSync(path.join(root, "desktop", "src", "react", "mobile", "MobileApp.tsx"), "utf-8");

    expect(entry).toContain("Codia 启动失败");
    expect(app).toContain("正在连接 Codia...");
    expect(app).toContain('<span className="mobile-titlebar-label">Codia</span>');
    expect(app).toContain('<h1 className="onboarding-title">Codia</h1>');
    expect(app).toContain('<h1 className="onboarding-title">网页访问 Codia</h1>');
  });

  it("uses the shared display name in PWA behavior audits", () => {
    const audit = fs.readFileSync(path.join(root, "scripts", "pwa-theme-behavior-audit.mjs"), "utf-8");

    expect(audit).toContain("../shared/product-branding.ts");
    expect(audit).toContain("PWA_DISPLAY_NAME");
    expect(audit).not.toMatch(/const\s+PWA_PRODUCT_TITLE\s*=/);
    expect(audit).not.toContain(`"${PWA_DISPLAY_NAME}"`);
  });
});
