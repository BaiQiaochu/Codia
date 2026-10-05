import { describe, expect, it } from "vitest";

import {
  buildDevWebClientConfig,
  buildDevWebPreviewUrl,
  normalizeServerInfoForDevWeb,
  resolveViteCommand,
} from "../scripts/dev-web-runtime.js";

describe("dev-web runtime helpers", () => {
  it("normalizes server-info into the client config injected into Vite", () => {
    const serverInfo = normalizeServerInfoForDevWeb({
      port: 4567,
      token: "dev-token",
    });

    expect(buildDevWebClientConfig(serverInfo, { clientPort: 5173 })).toEqual({
      serverPort: "5173",
      apiBaseUrl: "http://127.0.0.1:5173",
    });
  });

  it("rejects incomplete server-info instead of guessing a browser connection", () => {
    expect(() => normalizeServerInfoForDevWeb({ port: 4567 }))
      .toThrow("server-info token is required for dev-web");
    expect(() => normalizeServerInfoForDevWeb({ token: "dev-token" }))
      .toThrow("server-info port is required for dev-web");
  });

  it("builds the local browser URL without leaking the owner token into the address bar", () => {
    expect(buildDevWebPreviewUrl({ host: "127.0.0.1", port: 5173 }))
      .toBe("http://127.0.0.1:5173/index.html");
  });

  it("resolves the Vite CLI through node_modules .bin instead of package exports", () => {
    expect(resolveViteCommand("/repo", { platform: "darwin" }))
      .toBe("/repo/node_modules/.bin/vite");
    expect(resolveViteCommand("C:\\repo", { platform: "win32" }))
      .toBe("C:\\repo\\node_modules\\.bin\\vite.cmd");
  });
});
