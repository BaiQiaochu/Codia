import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mainPath = path.resolve("desktop/main.cjs");
const appInitPath = path.resolve("desktop/src/react/app-init.ts");

describe("desktop notification main-process contract", () => {
  it("resolves notification avatars from the triggering agent id", () => {
    const helperPath = path.resolve("desktop/src/shared/agent-avatar-path.cjs");
    const helper = require(helperPath);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-agent-avatar-"));
    const avatarDir = path.join(root, "agents", "agent-a", "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    const avatarPath = path.join(avatarDir, "agent.png");
    fs.writeFileSync(avatarPath, "png");

    expect(helper.resolveAgentAvatarPath(root, "agent-a")).toBe(avatarPath);
    expect(helper.resolveAgentAvatarPath(root, "../agent-a")).toBeNull();
    expect(helper.resolveAgentAvatarPath(root, "agent-b")).toBeNull();
  });

  it("wires session-scoped suppression and agent avatar icons into show-notification", () => {
    const source = fs.readFileSync(mainPath, "utf-8");

    expect(source).toContain('require("./src/shared/agent-avatar-path.cjs")');
    expect(source).toContain("function focusedWindowSessionPath");
    expect(source).toContain("getWindowSessionPath: focusedWindowSessionPath");
    expect(source).toContain("wrapIpcHandler(\"show-notification\", (_event, title, body, agentId, rawOptions)");
    expect(source).toContain("resolveAgentAvatarPath(codiaHome, agentId)");
    expect(source).toContain("nativeImage.createFromPath(avatarPath)");
    expect(source).toContain("options.icon = icon");
  });

  it("publishes the active chat session to the main process", () => {
    const source = fs.readFileSync(appInitPath, "utf-8");

    expect(source).toContain("function installActiveSessionFocusBridge");
    expect(source).toContain("active-session-changed");
    expect(source).toContain("currentSessionPath");
    expect(source).toContain("notifyMainWindow?.('active-session-changed'");
  });
});
