import { describe, expect, it } from "vitest";

import { applyDevEnvironment, defaultDevCodiaHome } from "../scripts/dev-env.js";

describe("development environment", () => {
  it("supports an isolated development home for parallel previews", () => {
    const env = { CODIA_DEV_HOME: "E:\\tmp\\codia-preview" };

    expect(defaultDevCodiaHome(env)).toBe("E:\\tmp\\codia-preview");
    expect(applyDevEnvironment(env, { nodeBin: "node.exe" })).toMatchObject({
      CODIA_HOME: "E:\\tmp\\codia-preview",
      CODIA_DEV_NODE_BIN: "node.exe",
    });
  });
});
