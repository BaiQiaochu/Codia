import { describe, expect, it } from "vitest";

import { applyDevEnvironment, defaultDevGsapHome } from "../scripts/dev-env.js";

describe("development environment", () => {
  it("supports an isolated development home for parallel previews", () => {
    const env = { GSAP_DEV_HOME: "E:\\tmp\\byoung-preview" };

    expect(defaultDevGsapHome(env)).toBe("E:\\tmp\\byoung-preview");
    expect(applyDevEnvironment(env, { nodeBin: "node.exe" })).toMatchObject({
      GSAP_HOME: "E:\\tmp\\byoung-preview",
      GSAP_DEV_NODE_BIN: "node.exe",
    });
  });
});
