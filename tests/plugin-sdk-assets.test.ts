/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import { createCodiaPluginSdk } from "../packages/plugin-sdk/src/index";

function makeTargetWindow(href: string) {
  const location = new URL(href);
  return {
    parent: { postMessage: vi.fn() },
    location,
    document: { referrer: "" },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  } as unknown as Window;
}

describe("plugin SDK asset URLs", () => {
  it("builds same-origin plugin asset URLs from the current iframe route", () => {
    const sdk = createCodiaPluginSdk({
      targetWindow: makeTargetWindow("http://127.0.0.1:14500/api/plugins/demo/panel?codia-theme=studio-light"),
      targetOrigin: "http://127.0.0.1:14500",
    });

    expect(sdk.assets.url("dist/app.js")).toBe(
      "http://127.0.0.1:14500/api/plugins/demo/assets/dist/app.js",
    );
    expect(sdk.assets.url("/images/logo icon.svg")).toBe(
      "http://127.0.0.1:14500/api/plugins/demo/assets/images/logo%20icon.svg",
    );
  });

  it("rejects unsafe plugin asset paths", () => {
    const sdk = createCodiaPluginSdk({
      targetWindow: makeTargetWindow("http://127.0.0.1:14500/api/plugins/demo/panel"),
      targetOrigin: "http://127.0.0.1:14500",
    });

    for (const unsafe of [
      "",
      "./app.js",
      "../app.js",
      "dist/../app.js",
      ".secret.js",
      "https://example.com/app.js",
      "dist\\app.js",
    ]) {
      expect(() => sdk.assets.url(unsafe)).toThrow("Invalid plugin asset path.");
    }
  });
});
