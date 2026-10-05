import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("desktop browser command wait wiring", () => {
  it("uses DOM stability waits for browser search, navigation, and wait commands", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "desktop/main.cjs"), "utf-8");

    expect(source).toContain('require("./src/shared/browser-wait.cjs")');
    expect(source).toContain("waitForBrowserState(view.webContents");
    expect(source).toContain("waitForBrowserState(wc");
    expect(source).toContain("diagnostics: { wait }");
    expect(source).toContain("FATAL_BROWSER_HOST_ERROR_PATTERNS");
    expect(source).toContain("_withLiveWebContents");
    expect(source).toContain("_bindBrowserViewLifecycle(view, sessionPath)");
  });
});
