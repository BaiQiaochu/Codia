import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");
const BROWSER_VIEWER_APP_PATH = path.join(process.cwd(), "desktop", "src", "react", "browser-viewer", "BrowserViewerApp.tsx");
const BROWSER_VIEWER_HTML_PATH = path.join(process.cwd(), "desktop", "src", "browser-viewer.html");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf(") {", start) + 2;
  expect(bodyStart).toBeGreaterThan(1);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated function ${name}`);
}

describe("desktop browser viewer window state", () => {
  it("does not wake secondary windows when showing the primary window", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "showPrimaryWindow");

    expect(body).toContain("focusExistingWindow(win)");
    expect(body).not.toContain("browserViewerWindow.show()");
    expect(body).not.toContain("settingsWindow.show()");
    expect(body).not.toContain("_viewerWindows");
  });

  it("hides the browser viewer when the active browser view is detached", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_detachActiveBrowserView");

    expect(body).toContain("contentView.removeChildView(view)");
    expect(body).toContain("_browserWebView = null");
    expect(body).toContain("_currentBrowserSession = null");
    expect(body).toContain("_currentBrowserTabId = null");
    expect(body).toContain('webContents.send("browser-update"');
    expect(body).toContain("browserViewerWindow.hide()");
  });

  it("keeps browser workspaces as multi-tab state and exposes tab IPC", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain("function _ensureBrowserWorkspace");
    expect(source).toContain("function _serializeBrowserWorkspace");
    expect(source).toContain("function _createBrowserTabRecord");
    expect(source).toContain("function _switchActiveBrowserTab");
    expect(source).toContain('wrapIpcHandler("browser-new-tab"');
    expect(source).toContain('wrapIpcHandler("browser-switch-tab"');
    expect(source).toContain('wrapIpcHandler("browser-close-tab"');
    expect(source).toContain('case "newTab"');
    expect(source).toContain('case "switchTab"');
    expect(source).toContain('case "closeTab"');
    expect(source).toContain('_detachActiveBrowserView({ view, hideIfVisible: true })');
    expect(source).toContain('reason: "emergency-stop"');
    expect(source).toContain("for (const tab of workspace.tabs?.values?.() || [])");
  });

  it("renders browser tabs and a manual address bar wired to tab navigation IPC", () => {
    const app = fs.readFileSync(BROWSER_VIEWER_APP_PATH, "utf-8");
    const html = fs.readFileSync(BROWSER_VIEWER_HTML_PATH, "utf-8");
    const preload = fs.readFileSync(path.join(process.cwd(), "desktop", "preload.cjs"), "utf-8");
    const platform = fs.readFileSync(path.join(process.cwd(), "desktop", "src", "modules", "platform.ts"), "utf-8");
    const types = fs.readFileSync(path.join(process.cwd(), "desktop", "src", "react", "types.ts"), "utf-8");
    const main = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(app).toContain("browser-tab-strip");
    expect(app).toContain("browser-tab-list");
    expect(app).toContain("browser-tab-close");
    expect(app).toContain("browserNewTab");
    expect(app).toContain("browserSwitchTab");
    expect(app).toContain("browserCloseTab");
    expect(app).toContain("browserNavigateTo");
    expect(app).toContain("address-form");
    expect(app).toContain("address-input");
    expect(app).not.toContain("window.codia");
    expect(html).toContain(".browser-tab-strip");
    expect(html).toContain(".browser-tab-list");
    expect(html).toContain(".address-form");
    expect(html).toContain(".address-input");
    expect(preload).toContain("browserNavigateTo");
    expect(platform).toContain("browserNavigateTo");
    expect(types).toContain("browserNavigateTo");
    expect(main).toContain('wrapIpcHandler("browser-navigate-url"');
  });
});
