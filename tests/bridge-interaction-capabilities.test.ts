import { describe, expect, it } from "vitest";
import {
  BRIDGE_INTERACTION_CAPABILITIES,
  createInteractionCapabilities,
  interactionCapabilitiesForPlatform,
} from "../lib/bridge/interaction-capabilities.ts";
import { BRIDGE_NOTIFY_PLATFORMS } from "../lib/bridge/bridge-context.ts";

describe("bridge interaction capabilities", () => {
  it("validates the declaration shape", () => {
    expect(() => createInteractionCapabilities({ confirmationMode: "text_command" } as any)).toThrow(
      /requires platform/,
    );
    expect(() => createInteractionCapabilities({ platform: "wechat", confirmationMode: "tap_card" } as any)).toThrow(
      /unsupported confirmation mode/,
    );
  });

  it("freezes declarations", () => {
    const capability = createInteractionCapabilities({
      platform: "wechat",
      confirmationMode: "text_command",
      source: "test",
    });
    expect(Object.isFrozen(capability)).toBe(true);
  });

  it("declares text-command confirmation for every bridge platform", () => {
    for (const platform of BRIDGE_NOTIFY_PLATFORMS) {
      const capability = interactionCapabilitiesForPlatform(platform);
      expect(capability.platform).toBe(platform);
      expect(capability.confirmationMode).toBe("text_command");
    }
    expect(Object.keys(BRIDGE_INTERACTION_CAPABILITIES).sort()).toEqual(
      [...BRIDGE_NOTIFY_PLATFORMS].sort(),
    );
  });

  it("throws for platforms without a declaration", () => {
    expect(() => interactionCapabilitiesForPlatform("desktop")).toThrow(
      /no interaction capabilities declared/,
    );
  });

  it("documents the /apply text protocol source for each platform", () => {
    for (const capability of Object.values(BRIDGE_INTERACTION_CAPABILITIES)) {
      expect(capability.source).toContain("bridge-commands");
      expect(capability.source).toContain("apply");
    }
  });
});
