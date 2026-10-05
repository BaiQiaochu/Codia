import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { API_PROVIDER_PRESETS } from "../desktop/src/react/utils/provider-presets.ts";

describe("provider preset alignment", () => {
  it("keeps first-run provider presets aligned with registry defaults", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-provider-presets-"));
    try {
      const registry = new ProviderRegistry(tempHome);

      for (const preset of API_PROVIDER_PRESETS) {
        const entry = registry.get(preset.value);
        expect(entry, `${preset.value} must be registered`).toBeTruthy();
        expect(
          { baseUrl: entry?.baseUrl, api: entry?.api },
          `${preset.value} preset should match registry defaults`,
        ).toEqual({ baseUrl: preset.url, api: preset.api });
      }
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
