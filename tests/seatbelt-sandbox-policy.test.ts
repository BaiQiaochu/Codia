import { describe, expect, it } from "vitest";
import { __testing } from "../lib/sandbox/seatbelt.js";

describe("macOS seatbelt sandbox policy projection", () => {
  const policy = {
    mode: "standard",
    writablePaths: [],
    readablePaths: [],
    protectedPaths: [],
    denyReadPaths: [],
  };

  it("allows outbound network by default", () => {
    const profile = __testing.generateProfile(policy);

    expect(profile).toContain("(allow network-outbound)");
    expect(profile).not.toContain("(deny network*)");
  });

  it("denies network only when sandbox network is explicitly disabled", () => {
    const profile = __testing.generateProfile(policy, { allowNetwork: false });

    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain("(allow network-outbound)");
  });
});
