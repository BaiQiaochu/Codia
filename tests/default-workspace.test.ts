import os from "os";
import path from "path";
import fs from "fs";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  DEFAULT_WORKSPACE_DIRNAME,
  resolveDefaultWorkspacePath,
} from "../shared/default-workspace.ts";

describe("default workspace contract", () => {
  it("places the default workspace under the user's Desktop", () => {
    const homeDir = path.join(os.tmpdir(), "gsap-default-workspace-home");

    expect(DEFAULT_WORKSPACE_DIRNAME).toBe("BYOUNG-Workspace");
    expect(resolveDefaultWorkspacePath(homeDir)).toBe(
      path.join(homeDir, "Desktop", "BYOUNG-Workspace"),
    );
  });

  it("uses 31 minutes as the patrol interval default", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MINUTES).toBe(31);
  });

  it("resolves the default workspace path without creating it during query access", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-default-workspace-query-"));
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    try {
      const { ConfigCoordinator } = await import("../core/config-coordinator.ts");
      const coordinator = new ConfigCoordinator({
        getAgentById: () => ({ config: { desk: {} } }),
      });
      const expected = path.join(tmpHome, "Desktop", "BYOUNG-Workspace");

      expect(coordinator.getHomeFolder("gsap")).toBe(expected);
      expect(fs.existsSync(expected)).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
