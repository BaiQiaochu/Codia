import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createHtmlPreviewRoute } from "../server/routes/html-preview.js";

function makeApp(options = {}) {
  const app = new Hono();
  app.route("", createHtmlPreviewRoute(options));
  return app;
}

describe("HTML preview route", () => {
  it("serves registered HTML with a CDN-capable CSP and no referrer leakage", async () => {
    const app = makeApp({
      randomId: () => "pv_test",
      randomToken: () => "preview_secret",
      now: () => 1000,
    });
    const html = '<script src="https://cdn.tailwindcss.com"></script><h1 class="text-red-500">Hello</h1>';

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "demo.html", content: html }),
    });

    expect(register.status).toBe(200);
    const registered = await register.json();
    expect(registered.previewUrl).toBe("http://127.0.0.1:14500/preview/html/pv_test?previewToken=preview_secret");

    const rendered = await app.request(registered.previewUrl);

    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("Content-Type")).toContain("text/html");
    expect(rendered.headers.get("Cache-Control")).toBe("no-store");
    expect(rendered.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(rendered.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const csp = rendered.headers.get("Content-Security-Policy") || "";
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("script-src 'unsafe-inline' https:");
    expect(csp).toContain("style-src 'unsafe-inline' https:");
    expect(csp).toContain("font-src https: data:");
    expect(csp).toContain("img-src 'self' https: data: blob:");
    expect(csp).toContain("media-src 'self' https: data: blob:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("script-src 'self'");
    expect(await rendered.text()).toBe(html);
  });

  it("adds a token-scoped asset base for HTML files so relative attachment images load through the preview route", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-html-preview-"));
    const sourceFilePath = path.join(tmp, "demo.html");
    const assetDir = path.join(tmp, "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(sourceFilePath, '<img src="./assets/pic.png">');
    fs.writeFileSync(path.join(assetDir, "pic.png"), Buffer.from("PNG"));

    const app = makeApp({
      randomId: () => "pv_assets",
      randomToken: () => "preview_secret",
      now: () => 1000,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "demo.html",
        content: '<html><head><title>Demo</title></head><body><img src="./assets/pic.png"></body></html>',
        sourceFilePath,
      }),
    });
    const registered = await register.json();
    const rendered = await app.request(registered.previewUrl);
    const html = await rendered.text();

    expect(html).toContain('<base href="http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/">');
    expect(html.indexOf('<base href="http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/">'))
      .toBeLessThan(html.indexOf('<title>Demo</title>'));

    const asset = await app.request("http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/assets/pic.png");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("image/png");
    expect(await asset.text()).toBe("PNG");

    const traversal = await app.request("http://127.0.0.1:14500/preview/html/pv_assets/assets/preview_secret/../demo.html");
    expect(traversal.status).toBe(404);
  });

  it("serves relative assets that resolve inside an explicit sandbox root", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-html-preview-sandbox-"));
    const pageDir = path.join(tmp, "pages");
    const assetDir = path.join(tmp, "shared");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.mkdirSync(assetDir, { recursive: true });
    const sourceFilePath = path.join(pageDir, "demo.html");
    fs.writeFileSync(sourceFilePath, '<img src="../shared/pic.png">');
    fs.writeFileSync(path.join(assetDir, "pic.png"), Buffer.from("PNG"));

    const app = makeApp({
      randomId: () => "pv_sandbox",
      randomToken: () => "preview_secret",
      now: () => 1000,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "demo.html",
        content: '<html><head></head><body><img src="../shared/pic.png"></body></html>',
        sourceFilePath,
        sandboxRoot: tmp,
      }),
    });

    expect(register.status).toBe(200);
    const asset = await app.request("http://127.0.0.1:14500/preview/html/pv_sandbox/assets/preview_secret/..%2Fshared%2Fpic.png");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("image/png");
    expect(await asset.text()).toBe("PNG");

    const outside = await app.request("http://127.0.0.1:14500/preview/html/pv_sandbox/assets/preview_secret/..%2F..%2Foutside.png");
    expect(outside.status).toBe(404);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("requires the per-preview token and expires entries from memory", async () => {
    let now = 1000;
    const app = makeApp({
      randomId: () => "pv_expiring",
      randomToken: () => "preview_secret",
      now: () => now,
      ttlMs: 10,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "demo.html", content: "<h1>Hello</h1>" }),
    });
    const { previewUrl } = await register.json();

    expect((await app.request("http://127.0.0.1:14500/preview/html/pv_expiring?previewToken=wrong")).status).toBe(404);
    expect((await app.request(previewUrl)).status).toBe(200);

    now = 1011;
    expect((await app.request(previewUrl)).status).toBe(404);
  });

  it("rejects oversized preview bodies before storing them", async () => {
    const app = makeApp({
      randomId: () => "pv_large",
      randomToken: () => "preview_secret",
      maxContentBytes: 8,
    });

    const register = await app.request("http://127.0.0.1:14500/api/preview/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "demo.html", content: "<h1>too large</h1>" }),
    });

    expect(register.status).toBe(413);
    expect(await register.json()).toEqual({ error: "html_preview_too_large" });
  });
});
