import { describe, expect, it } from "vitest";
import { buildProviderCompatOptions } from "../core/llm-request-policy.ts";

describe("llm request provider compat policy", () => {
  it("keeps normalized call purpose metadata for provider compat", () => {
    expect(buildProviderCompatOptions({
      mode: "utility",
      callPurpose: " Auxiliary_Vision ",
      explicitMaxTokens: null,
      outputBudgetSource: "system",
    })).toEqual({
      mode: "utility",
      callPurpose: "auxiliary_vision",
    });
  });

  it("only forwards output budget source when max tokens were explicit", () => {
    expect(buildProviderCompatOptions({
      mode: "chat",
      callPurpose: "summary",
      explicitMaxTokens: 1200,
      outputBudgetSource: "system",
    })).toEqual({
      mode: "chat",
      callPurpose: "summary",
      outputBudgetSource: "system",
    });
  });

  it("drops unknown call purposes instead of leaking arbitrary metadata", () => {
    expect(buildProviderCompatOptions({
      mode: "utility",
      callPurpose: "debug-admin",
      explicitMaxTokens: undefined,
      outputBudgetSource: "user",
    })).toEqual({
      mode: "utility",
    });
  });
});
