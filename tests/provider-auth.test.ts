import { describe, expect, it } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";
import {
  assertValidProviderCredentialPatch,
  collectProviderHeaderSecretPatchPaths,
  maskProviderHeaders,
  normalizeProviderApiKey,
  normalizeProviderHeaders,
  resolveProviderHeadersPatch,
} from "../shared/provider-auth.ts";

describe("provider auth helpers", () => {
  it("normalizes provider request headers and drops unsafe transport headers", () => {
    expect(normalizeProviderHeaders({
      " Authorization ": "Bearer gateway",
      "X-Corp-Auth": "token",
      Host: "evil.example",
      "Bad Header": "bad",
      Empty: "",
    })).toEqual({
      Authorization: "Bearer gateway",
      "X-Corp-Auth": "token",
    });
  });

  it("quarantines legacy API keys and header values that are not printable ASCII", () => {
    expect(normalizeProviderApiKey("sk-safe-token")).toBe("sk-safe-token");
    expect(normalizeProviderApiKey("sk-中文-token")).toBe("");
    expect(normalizeProviderApiKey("sk-line\nfeed")).toBe("");

    expect(normalizeProviderHeaders({
      Authorization: "Bearer safe-token",
      "X-Chinese": "供应商甲",
      "X-Newline": "line-1\r\nline-2",
      "X-Control": "value\u0001",
    })).toEqual({
      Authorization: "Bearer safe-token",
    });
  });

  it("rejects unsafe values in provider credential save patches with an HTTP 400 error", () => {
    for (const patch of [
      { api_key: "sk-中文" },
      { api_key: "sk-line\nfeed" },
      { headers: { Authorization: "Bearer value\u0001" } },
    ]) {
      expect(() => assertValidProviderCredentialPatch(patch, "providers.test")).toThrow(
        expect.objectContaining({ statusCode: 400, code: "invalid_provider_credential_value" }),
      );
    }

    expect(() => assertValidProviderCredentialPatch({
      api_key: MASKED_SECRET,
      headers: { Authorization: MASKED_SECRET },
    }, "providers.test", { allowMasked: true })).not.toThrow();
  });

  it("masks provider request header values and preserves masked patches by header name", () => {
    const existing = {
      Authorization: "Bearer saved",
      "X-Corp-Auth": "saved-token",
    };

    expect(maskProviderHeaders(existing)).toEqual({
      Authorization: MASKED_SECRET,
      "X-Corp-Auth": MASKED_SECRET,
    });

    expect(resolveProviderHeadersPatch({
      existing,
      patch: {
        authorization: MASKED_SECRET,
        "X-Corp-Auth": "new-token",
      },
    })).toEqual({
      authorization: "Bearer saved",
      "X-Corp-Auth": "new-token",
    });
  });

  it("treats unmasked provider request headers as secret mutations", () => {
    expect(collectProviderHeaderSecretPatchPaths({
      Authorization: MASKED_SECRET,
      "X-Corp-Auth": "plain-token",
    }, "providers.proxy.headers")).toEqual([
      "providers.proxy.headers.X-Corp-Auth",
    ]);
  });
});
