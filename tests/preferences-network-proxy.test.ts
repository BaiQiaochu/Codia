import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import { DEFAULT_NETWORK_PROXY_CONFIG } from "../shared/network-proxy.ts";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-prefs-network-proxy-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

describe("PreferencesManager network proxy preference", () => {
  it("defaults to system proxy mode", () => {
    const prefs = makePrefs();

    expect(prefs.getNetworkProxy()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
  });

  it("stores normalized manual proxy config", () => {
    const prefs = makePrefs();

    const saved = prefs.setNetworkProxy({
      mode: "manual",
      httpProxy: "http://127.0.0.1:7890/",
      noProxy: "localhost 127.0.0.1",
    });

    expect(saved.httpProxy).toBe("http://127.0.0.1:7890");
    expect(saved.noProxy).toBe("localhost, 127.0.0.1");
    expect(prefs.getPreferences().network_proxy).toEqual(saved);
    expect(prefs.getNetworkProxy()).toEqual(saved);
  });

  it("rejects invalid manual proxy config without mutating the previous value", () => {
    const prefs = makePrefs();
    prefs.setNetworkProxy({ mode: "direct" });

    expect(() => prefs.setNetworkProxy({ mode: "manual" })).toThrow(/requires at least one proxy URL/);
    expect(prefs.getNetworkProxy().mode).toBe("direct");
  });
});
