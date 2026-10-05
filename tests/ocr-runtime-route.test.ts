import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("OCR runtime static route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeRuntimeDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-ocr-runtime-"));
    fs.mkdirSync(path.join(tmpDir, "models"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "ort"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "models", "PP-OCRv5_mobile_det.tar"), "det-model");
    fs.writeFileSync(path.join(tmpDir, "ort", "ort-wasm-simd-threaded.wasm"), "wasm");
    return tmpDir;
  }

  it("serves packaged OCR model and wasm files under /ocr-runtime", async () => {
    const runtimeDir = makeRuntimeDir();
    const { createOcrRuntimeRoute } = await import("../server/routes/ocr-runtime.js");
    const app = new Hono();
    app.route("", createOcrRuntimeRoute({ runtimeDir }));

    const model = await app.request("/ocr-runtime/models/PP-OCRv5_mobile_det.tar");
    expect(model.status).toBe(200);
    expect(model.headers.get("content-type")).toContain("application/x-tar");
    expect(await model.text()).toBe("det-model");

    const wasm = await app.request("/ocr-runtime/ort/ort-wasm-simd-threaded.wasm");
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toContain("application/wasm");
    expect(await wasm.text()).toBe("wasm");
  });

  it("does not serve files outside the packaged OCR runtime root", async () => {
    const runtimeDir = makeRuntimeDir();
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "secret");
    const { createOcrRuntimeRoute } = await import("../server/routes/ocr-runtime.js");
    const app = new Hono();
    app.route("", createOcrRuntimeRoute({ runtimeDir }));

    expect((await app.request("/ocr-runtime/../secret.txt")).status).toBe(404);
    expect((await app.request("/ocr-runtime/models/../../secret.txt")).status).toBe(404);
    expect((await app.request("/ocr-runtime/models/missing.tar")).status).toBe(404);
  });
});
