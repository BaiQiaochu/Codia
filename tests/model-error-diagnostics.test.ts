import { describe, expect, it } from "vitest";
import { buildModelErrorDiagnostic } from "../server/model-error-diagnostics.ts";

describe("model error diagnostics", () => {
  it("classifies the ByteString failure caused by a non-ASCII header value", () => {
    const error = Object.assign(new TypeError(
      "Cannot convert argument to a ByteString because the character at index 7 has a value greater than 255.",
    ), { code: "ERR_INVALID_CHAR" });

    expect(buildModelErrorDiagnostic(error, {
      provider: "provider-a",
      id: "shared-model",
    })).toMatchObject({
      model: { provider: "provider-a", id: "shared-model" },
      details: {
        classification: "invalid_request_header",
        error: { name: "TypeError", code: "ERR_INVALID_CHAR" },
      },
    });
  });

  it("redacts custom header values from the underlying cause", () => {
    const error = Object.assign(new Error("Request failed."), {
      cause: new Error("request headers X-Provider-Credential: 供应商甲"),
    });

    const diagnostic = buildModelErrorDiagnostic(error, null);

    expect(diagnostic.details.cause?.message).toContain("[redacted]");
    expect(diagnostic.details.cause?.message).not.toContain("供应商甲");
  });
});
