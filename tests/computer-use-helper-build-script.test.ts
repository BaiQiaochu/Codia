import path from "path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computerUseHelperOutputDir,
  patchCuaDriverAppStateSource,
  patchCuaDriverClickToolSource,
  resolveComputerUseHelperBuildArch,
  shouldBuildComputerUseHelper,
  swiftBuildScratchPath,
  swiftArchForNodeArch,
} from "../scripts/build-computer-use-helper.mjs";

describe("Computer Use helper build script", () => {
  it.each(["LF", "CRLF", "extra blank lines"])("patches the pinned upstream Swift sources with %s formatting", (format) => {
    const read = (name: string) => {
      const original = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/cua-driver", name), "utf8").replace(/\r\n/g, "\n");
      return format === "CRLF" ? original.replace(/\n/g, "\r\n")
        : format === "extra blank lines" ? original.replace(/\n/g, "\n\n") : original;
    };
    const state = patchCuaDriverAppStateSource(read("AppState.swift"));
    expect(state).toContain("applyCuaDriverAXMessagingTimeout(root)");
    expect(state).toContain("bundleId: running.bundleIdentifier");
    expect(state).toContain("maxActionableElements = 48");
    expect(state).toContain("descendantLabelSummary(of: element)");
    expect(patchCuaDriverAppStateSource(state)).toBe(state);
    const click = patchCuaDriverClickToolSource(read("ClickTool.swift"));
    expect(click).toContain('"show_default_ui": "AXShowDefaultUI"');
    expect(patchCuaDriverClickToolSource(click)).toBe(click);
  });

  it("rejects unexpected upstream code instead of silently omitting a patch", () => {
    const state = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/cua-driver/AppState.swift"), "utf8");
    expect(() => patchCuaDriverAppStateSource(state.replace("maxDepth = 25", "maxDepth = 30")))
      .toThrow("Cua patch anchor not found: bounded AX tree walk");
  });

  it("skips the Swift helper build outside macOS", () => {
    expect(shouldBuildComputerUseHelper({ platform: "linux" })).toBe(false);
    expect(shouldBuildComputerUseHelper({ platform: "win32" })).toBe(false);
    expect(shouldBuildComputerUseHelper({ platform: "darwin" })).toBe(true);
  });

  it("maps Node architecture names to Swift architecture names", () => {
    expect(swiftArchForNodeArch("arm64")).toBe("arm64");
    expect(swiftArchForNodeArch("x64")).toBe("x86_64");
  });

  it("lets CI choose the helper build architecture explicitly", () => {
    expect(resolveComputerUseHelperBuildArch({
      argv: ["node", "scripts/build-computer-use-helper.mjs", "x64"],
      env: { CODIA_COMPUTER_USE_HELPER_ARCH: "arm64" },
      arch: "arm64",
    })).toBe("x64");
    expect(resolveComputerUseHelperBuildArch({
      argv: ["node", "scripts/build-computer-use-helper.mjs"],
      env: { CODIA_COMPUTER_USE_HELPER_ARCH: "x64" },
      arch: "arm64",
    })).toBe("x64");
  });

  it("writes the macOS helper into the Electron extraResources source directory", () => {
    expect(computerUseHelperOutputDir({
      rootDir: "/repo",
      osName: "mac",
      arch: "arm64",
    })).toBe(path.join("/repo", "dist-computer-use", "mac-arm64"));
  });

  it("keeps SwiftPM checkouts in the ignored cache directory instead of the source tree", () => {
    expect(swiftBuildScratchPath({
      rootDir: "/repo",
      arch: "arm64",
    })).toBe(path.join("/repo", ".cache", "computer-use-helper", "swift-build", "mac-arm64"));
  });
});
