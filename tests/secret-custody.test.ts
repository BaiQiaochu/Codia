import { describe, expect, it } from "vitest";

describe("secret custody helpers", () => {
  it("masks secrets in server responses while preserving empty fields", async () => {
    const { MASKED_SECRET, maskSecretValue, maskObjectSecrets } = await import("../shared/secret-custody.ts");

    expect(maskSecretValue("sk-test-secret")).toBe(MASKED_SECRET);
    expect(maskSecretValue("")).toBe("");
    expect(maskObjectSecrets({
      api_key: "sk-provider",
      token: "tg-token",
      appSecret: "fs-secret",
      visible: "safe",
    })).toEqual({
      api_key: MASKED_SECRET,
      token: MASKED_SECRET,
      appSecret: MASKED_SECRET,
      visible: "safe",
    });
  });

  it("resolves masked request values back to the saved secret instead of storing the mask", async () => {
    const { MASKED_SECRET, resolveSecretPatch } = await import("../shared/secret-custody.ts");

    expect(resolveSecretPatch({
      patch: { api_key: MASKED_SECRET, base_url: "https://api.example/v1" },
      existing: { api_key: "sk-saved", base_url: "https://old.example/v1" },
      secretKeys: ["api_key"] as any,
    })).toEqual({
      api_key: "sk-saved",
      base_url: "https://api.example/v1",
    });

    expect(resolveSecretPatch({
      patch: { api_key: "", base_url: "https://api.example/v1" },
      existing: { api_key: "sk-saved" },
      secretKeys: ["api_key"] as any,
    })).toEqual({
      api_key: "",
      base_url: "https://api.example/v1",
    });
  });

  it("collects real secret mutations but ignores masked placeholders", async () => {
    const { MASKED_SECRET, collectSecretPatchPaths } = await import("../shared/secret-custody.ts");

    expect(collectSecretPatchPaths({
      providers: {
        deepseek: { api_key: "sk-new", base_url: "https://api.deepseek.com" },
        openai: { api_key: MASKED_SECRET },
      },
      bridge: {
        telegram: { token: "" },
      },
      visible: "safe",
    })).toEqual([
      "providers.deepseek.api_key",
      "bridge.telegram.token",
    ]);
  });
});
