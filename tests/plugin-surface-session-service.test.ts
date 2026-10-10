import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  PluginSurfaceSessionError,
  issuePluginSurfaceSession,
  verifyPluginSurfaceSession,
} from "../core/plugin-surface-session-service.ts";

function withTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-surface-"));
}

describe("plugin surface session service", () => {
  it("issues and verifies a plugin-bound surface session", () => {
    const codiaHome = withTempHome();
    const issued = issuePluginSurfaceSession({
      codiaHome,
      pluginId: "demo-plugin",
      principalId: "principal_local_owner",
      now: "2026-06-11T00:00:00.000Z",
      ttlMs: 60_000,
    });

    expect(issued.token).toContain(".");
    expect(issued.pluginId).toBe("demo-plugin");

    const verified = verifyPluginSurfaceSession({
      codiaHome,
      pluginId: "demo-plugin",
      token: issued.token,
      now: "2026-06-11T00:00:30.000Z",
    });

    expect(verified).toMatchObject({
      sessionId: issued.sessionId,
      pluginId: "demo-plugin",
      principalId: "principal_local_owner",
    });
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it("rejects sessions for another plugin", () => {
    const codiaHome = withTempHome();
    const issued = issuePluginSurfaceSession({
      codiaHome,
      pluginId: "demo-plugin",
      principalId: "principal_local_owner",
    });

    expect(() => verifyPluginSurfaceSession({
      codiaHome,
      pluginId: "other-plugin",
      token: issued.token,
    })).toThrow(PluginSurfaceSessionError);
  });

  it("rejects expired sessions with a stable code", () => {
    const codiaHome = withTempHome();
    const issued = issuePluginSurfaceSession({
      codiaHome,
      pluginId: "demo-plugin",
      principalId: "principal_local_owner",
      now: "2026-06-11T00:00:00.000Z",
      ttlMs: 1_000,
    });

    try {
      verifyPluginSurfaceSession({
        codiaHome,
        pluginId: "demo-plugin",
        token: issued.token,
        now: "2026-06-11T00:00:01.000Z",
      });
      throw new Error("expected expired session rejection");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PluginSurfaceSessionError);
      expect(err.code).toBe("plugin_surface_session_expired");
      expect(err.status).toBe(403);
    }
  });
});
