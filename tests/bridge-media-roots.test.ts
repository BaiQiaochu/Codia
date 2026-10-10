import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectBridgeMediaAllowedRoots, isInsideBridgeMediaRoot } from "../lib/bridge/media-roots.js";

describe("Bridge media allowed roots", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeDir(name) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-bridge-roots-"));
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("includes target and known agent workspaces from getHomeCwd", () => {
    const codiaHome = makeDir("codia-home");
    const ownerHome = makeDir("owner-workspace");
    const otherHome = makeDir("other-workspace");
    const engine = {
      codiaHome,
      getHomeCwd: vi.fn((agentId) => {
        if (agentId === "owner") return ownerHome;
        if (agentId === "other") return otherHome;
        return null;
      }),
      getAgents: vi.fn(() => new Map([
        ["owner", { id: "owner", config: { desk: {} } }],
        ["other", { id: "other", config: { desk: {} } }],
      ])),
    };

    const roots = collectBridgeMediaAllowedRoots(engine, { agentId: "owner" });

    expect(roots).toContain(fs.realpathSync(codiaHome));
    expect(roots).toContain(fs.realpathSync(ownerHome));
    expect(roots).toContain(fs.realpathSync(otherHome));
    expect(engine.getHomeCwd).toHaveBeenCalledWith("owner");
    expect(engine.getHomeCwd).toHaveBeenCalledWith("other");
  });

  it("uses realpath containment checks for files under allowed roots", () => {
    const root = makeDir("workspace");
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    const filePath = path.join(nested, "out.txt");
    fs.writeFileSync(filePath, "ok");

    const roots = [fs.realpathSync(root)];

    expect(isInsideBridgeMediaRoot(filePath, roots)).toBe(true);
    expect(isInsideBridgeMediaRoot(path.join(tmpDir, "outside.txt"), roots)).toBe(false);
  });
});
