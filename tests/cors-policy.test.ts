import { describe, expect, it } from "vitest";
import { isCorsOriginAllowed } from "../server/http/cors-policy.js";

describe("CORS policy", () => {
  it("allows Electron file and loopback browser origins by default", () => {
    expect(isCorsOriginAllowed({ origin: "null" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "file://" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "http://localhost:5173" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "http://127.0.0.1:14500" })).toBe(true);
  });

  it("does not allow arbitrary LAN or public origins unless explicitly configured", () => {
    expect(isCorsOriginAllowed({ origin: "http://192.168.31.75:5173" })).toBe(false);
    expect(isCorsOriginAllowed({ origin: "https://example.com" })).toBe(false);
    expect(isCorsOriginAllowed({
      origin: "https://example.com",
      configuredOrigin: "https://example.com",
    })).toBe(true);
    expect(isCorsOriginAllowed({
      origin: "https://evil.example",
      configuredOrigin: "https://example.com",
    })).toBe(false);
  });
});
