import { describe, expect, it } from "vitest";
import {
  allowsMissingApiKey,
  isLocalBaseUrl,
  normalizePublicBaseUrl,
  resolveWebAccessBindHost,
} from "../shared/net-utils.ts";

describe("web access network helpers", () => {
  it("binds locally by default and externally only when explicitly enabled", () => {
    expect(resolveWebAccessBindHost(null)).toBe("127.0.0.1");
    expect(resolveWebAccessBindHost({ external_enabled: false })).toBe("127.0.0.1");
    expect(resolveWebAccessBindHost({ external_enabled: true })).toBe("0.0.0.0");
  });

  it("normalizes public base URLs safely", () => {
    expect(normalizePublicBaseUrl("https://api.example.com/codia/?token=secret#x")).toBe("https://api.example.com/codia");
    expect(normalizePublicBaseUrl("http://1.2.3.4:8123///")).toBe("http://1.2.3.4:8123");
    expect(normalizePublicBaseUrl("file:///tmp/codia")).toBe("");
    expect(normalizePublicBaseUrl("not a url")).toBe("");
  });

  it("treats loopback and private model endpoints as local/no-key capable", () => {
    expect(isLocalBaseUrl("http://127.0.0.1:30000/v1")).toBe(true);
    expect(isLocalBaseUrl("http://192.168.1.20:30000/v1")).toBe(true);
    expect(isLocalBaseUrl("http://10.0.0.8:30000/v1")).toBe(true);
    expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("allows missing API keys for auth_type none providers", () => {
    expect(allowsMissingApiKey({ baseUrl: "https://models.example.test/v1", authType: "none" })).toBe(true);
    expect(allowsMissingApiKey({ baseUrl: "https://models.example.test/v1", authType: "optional" })).toBe(true);
    expect(allowsMissingApiKey({ baseUrl: "https://models.example.test/v1", authType: "api-key" })).toBe(false);
  });
});
