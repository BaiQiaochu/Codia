import { describe, expect, it } from "vitest";
import { desktopLaunchEnv } from "../scripts/e2e-desktop-launcher.mjs";

describe("desktop E2E SDK network isolation", () => {
  it("disables SDK startup network, telemetry and version checks for smoke runs", () => {
    const env = desktopLaunchEnv({ CODIA_E2E: "1" }, {});

    expect(env).toMatchObject({
      CODIA_PORT: "0",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
  });

  it("keeps smoke isolation despite inherited settings without mutating the parent environment", () => {
    const baseEnv = {
      PI_OFFLINE: "0",
      PI_TELEMETRY: "1",
      PI_SKIP_VERSION_CHECK: "0",
      ELECTRON_RUN_AS_NODE: "1",
    };
    const overrides = { CODIA_E2E: "1", CODIA_PORT: "32123", PI_OFFLINE: "0" };
    const env = desktopLaunchEnv(overrides, baseEnv);

    expect(env).toMatchObject({
      CODIA_PORT: "32123",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(baseEnv.PI_OFFLINE).toBe("0");
    expect(baseEnv.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(overrides.PI_OFFLINE).toBe("0");
  });

  it("preserves SDK settings outside E2E runs", () => {
    const baseEnv = { PI_OFFLINE: "0", PI_TELEMETRY: "1", PI_SKIP_VERSION_CHECK: "0" };

    expect(desktopLaunchEnv({}, baseEnv)).toEqual(baseEnv);
    expect(desktopLaunchEnv({}, {})).toEqual({});
  });
});
