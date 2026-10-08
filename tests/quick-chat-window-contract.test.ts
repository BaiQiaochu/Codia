import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf(") {", start) + 2;
  expect(bodyStart).toBeGreaterThan(1);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated function ${name}`);
}

describe("desktop quick chat window contract", () => {
  it("registers the global shortcut as a focused-window toggle", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const registerBody = functionBody(source, "registerQuickChatShortcut");
    const toggleBody = functionBody(source, "toggleQuickChatWindow");

    expect(registerBody).toContain("globalShortcut.register(shortcut, toggleQuickChatWindow)");
    expect(registerBody).not.toContain("globalShortcut.register(shortcut, showQuickChatWindow)");
    expect(toggleBody).toContain("quickChatWindow.isVisible()");
    expect(toggleBody).toContain("quickChatWindow.isFocused()");
    expect(toggleBody).toContain("hideQuickChatWindow()");
    expect(toggleBody).toContain("showQuickChatWindow()");
  });

  it("hides focused Quick Chat without letting the main window take focus", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const hideBody = functionBody(source, "hideQuickChatWindow");
    const suspendBody = functionBody(source, "suspendMainWindowFocusForQuickChatHide");

    expect(hideBody).toContain("suspendMainWindowFocusForQuickChatHide()");
    expect(hideBody).toContain("quickChatWindow.hide()");
    expect(suspendBody).toContain("mainWindow.setFocusable(false)");
    expect(suspendBody).toContain("setTimeout");
    expect(suspendBody).toContain("mainWindow.setFocusable(true)");
  });

  it("restores the macOS Dock icon when Quick Chat is explicitly shown", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const showBody = functionBody(source, "showQuickChatWindow");

    expect(showBody).toContain('if (process.platform === "darwin")');
    expect(showBody).toContain("app.dock.show()");
    expect(showBody).toContain("win.show()");
    expect(showBody).toContain("win.focus()");
  });

  it("does not mark the macOS Quick Chat window as taskbar-skipping", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const createBody = functionBody(source, "createQuickChatWindow");

    expect(createBody).toContain('skipTaskbar: process.platform !== "darwin"');
    expect(createBody).not.toContain("skipTaskbar: true");
  });
});
