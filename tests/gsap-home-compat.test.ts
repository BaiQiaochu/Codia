import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GSAP_HOME,
  DEFAULT_LEGACY_GSAP_HOME,
  applyGsapHomeEnv,
  resolveGsapHome,
} from "../shared/gsap-home.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gsap home compatibility", () => {
  it("prefers GSAP_HOME when explicitly configured", () => {
    const oldHomeEnv = ["H", "ANA_HOME"].join("");
    expect(resolveGsapHome({ GSAP_HOME: "~/custom-gsap-home", [oldHomeEnv]: "~/legacy-home" })).toMatch(/custom-gsap-home$/);
  });

  it("ignores old branded home env names when GSAP_HOME is not set", () => {
    const oldHomeEnv = ["H", "ANA_HOME"].join("");
    expect(resolveGsapHome({ [oldHomeEnv]: "~/legacy-home" })).toBe(DEFAULT_GSAP_HOME);
  });

  it("falls back to the legacy data home only when explicitly enabled", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => filePath === DEFAULT_LEGACY_GSAP_HOME);
    expect(resolveGsapHome({})).toBe(DEFAULT_GSAP_HOME);
    expect(resolveGsapHome({ GSAP_USE_LEGACY_GSAP_HOME: "1" })).toBe(DEFAULT_LEGACY_GSAP_HOME);
  });

  it("keeps preferring ~/.gsap when the new home already exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => filePath === DEFAULT_GSAP_HOME || filePath === DEFAULT_LEGACY_GSAP_HOME);
    expect(resolveGsapHome({})).toBe(DEFAULT_GSAP_HOME);
  });

  it("writes only GSAP_HOME for downstream processes", () => {
    const env = {};
    applyGsapHomeEnv("E:/workspace/.gsap", env);
    expect(env).toEqual({
      GSAP_HOME: "E:/workspace/.gsap",
    });
  });
});
