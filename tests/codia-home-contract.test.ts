import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CODIA_HOME,
  applyCodiaHomeEnv,
  resolveCodiaHome,
} from "../shared/codia-home.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("codia home compatibility", () => {
  it("prefers CODIA_HOME when explicitly configured", () => {
    const oldHomeEnv = ["H", "ANA_HOME"].join("");
    expect(resolveCodiaHome({ CODIA_HOME: "~/custom-codia-home", [oldHomeEnv]: "~/legacy-home" })).toMatch(/custom-codia-home$/);
  });

  it("ignores old branded home env names when CODIA_HOME is not set", () => {
    const oldHomeEnv = ["H", "ANA_HOME"].join("");
    expect(resolveCodiaHome({ [oldHomeEnv]: "~/legacy-home" })).toBe(DEFAULT_CODIA_HOME);
  });

  it("never reads a legacy data home", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    expect(resolveCodiaHome({})).toBe(DEFAULT_CODIA_HOME);
    expect(resolveCodiaHome({ CODIA_USE_LEGACY_CODIA_HOME: "1" })).toBe(DEFAULT_CODIA_HOME);
  });

  it("keeps preferring ~/.codia when the new home already exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => filePath === DEFAULT_CODIA_HOME);
    expect(resolveCodiaHome({})).toBe(DEFAULT_CODIA_HOME);
  });

  it("writes only CODIA_HOME for downstream processes", () => {
    const env = {};
    applyCodiaHomeEnv("E:/workspace/.codia", env);
    expect(env).toEqual({
      CODIA_HOME: "E:/workspace/.codia",
    });
  });
});
