import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PWA_DISPLAY_NAME } from "../shared/product-branding.ts";

describe("mobile static route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("serves the dedicated mobile renderer under /mobile without falling back to desktop index", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-mobile-static-"));
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "themes"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "locales"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), `<!doctype html><title>${PWA_DISPLAY_NAME}</title><div id="react-root"></div>`, "utf-8");
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<!doctype html><title>Desktop</title><div id=\"react-root\"></div>", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "styles.css"), ".root { color: black; }", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "assets", "app.js"), "console.log('ok')", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "themes", "studio-light.css"), ":root { --bg: white; }", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "locales", "zh.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "manifest.webmanifest"), "{}", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "sw.js"), "self.addEventListener('fetch', () => {})", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "icon.png"), "png", "utf-8");

    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.js");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ distDir: tmpDir }));

    const html = await app.request("/mobile/");
    expect(html.status).toBe(200);
    const htmlText = await html.text();
    expect(htmlText).toContain(PWA_DISPLAY_NAME);
    expect(htmlText).not.toContain("<title>Desktop</title>");

    const asset = await app.request("/mobile/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("console.log");

    const stylesheet = await app.request("/mobile/styles.css");
    expect(stylesheet.status).toBe(200);
    expect(await stylesheet.text()).toContain("color");

    expect((await app.request("/mobile/themes/studio-light.css")).status).toBe(200);
    expect((await app.request("/mobile/locales/zh.json")).status).toBe(200);
    expect((await app.request("/mobile/manifest.webmanifest")).status).toBe(200);
    expect((await app.request("/mobile/sw.js")).status).toBe(200);
    expect((await app.request("/mobile/icon.png")).status).toBe(200);
    expect((await app.request("/mobile/index.html")).status).toBe(404);

    const desktopHtml = await app.request("/desktop/");
    expect(desktopHtml.status).toBe(200);
    expect(await desktopHtml.text()).toContain(PWA_DISPLAY_NAME);
    expect((await app.request("/desktop/assets/app.js")).status).toBe(200);
    expect((await app.request("/desktop/styles.css")).status).toBe(200);
    expect((await app.request("/desktop/index.html")).status).toBe(404);
    expect((await app.request("/mobile/../server/index.js")).status).toBe(404);
    expect((await app.request("/desktop/../server/index.js")).status).toBe(404);
  });
});
