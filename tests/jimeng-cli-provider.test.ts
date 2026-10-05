import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";
import * as provider from "../plugins/jimeng-cli/providers/jimeng-cli.ts";

describe("Jimeng CLI provider contribution", () => {
  it("declares an optional media-only provider", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-jimeng-provider-"));
    const registry = new ProviderRegistry(tmpHome);

    try {
      registry.registerProviderContribution({
        ...provider,
        _pluginId: "jimeng-cli",
      });

      expect(registry.get("jimeng-cli")).toMatchObject({
        id: "jimeng-cli",
        displayName: "Jimeng CLI",
        authType: "none",
        source: { kind: "plugin", pluginId: "jimeng-cli" },
      });
      expect(registry.resolveChatProvider("jimeng-cli")).toMatchObject({
        providerId: "jimeng-cli",
        projection: "none",
      });

      expect(registry.getMediaModels("jimeng-cli", "image_generation")).toEqual([
        expect.objectContaining({
          id: "jimeng-image-5.0",
          displayName: "Jimeng Image 5.0",
          protocolId: "jimeng-cli-images",
          inputs: ["text", "image"],
          outputs: ["image"],
          resolutions: ["2k", "4k"],
        }),
      ]);

      expect(registry.getMediaModels("jimeng-cli", "video_generation")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "seedance2.0fast",
          displayName: "Seedance 2.0 Fast",
          protocolId: "jimeng-cli-videos",
          inputs: ["text", "image"],
          outputs: ["video"],
          supportsAsync: true,
        }),
        expect.objectContaining({
          id: "seedance2.0_vip",
          displayName: "Seedance 2.0 VIP",
          resolutions: ["720p", "1080p"],
        }),
        expect.objectContaining({
          id: "3.5pro",
          displayName: "Jimeng Video 3.5 Pro",
          duration: { min: 4, max: 12 },
        }),
      ]));
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
