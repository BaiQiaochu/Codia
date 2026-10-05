// @ts-nocheck
import { describe, expect, it } from "vitest";
import { createPwaAuth, __test__ } from "../server/pwa-auth.js";

async function request(route, path, init) {
  return await route.request(`http://localhost${path}`, init);
}

describe("PWA auth", () => {
  it("accepts both configured accounts and rejects invalid credentials", async () => {
    const { route, isValidToken } = createPwaAuth({ secret: "test-secret" });

    for (const account of ["15207718306", "BoshiPOC"]) {
      const response = await request(route, "/pwa-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, password: "123456" }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.account).toBe(account);
      expect(isValidToken(data.token)).toBe(true);
    }

    const denied = await request(route, "/pwa-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "BoshiPOC", password: "bad" }),
    });
    expect(denied.status).toBe(401);
  });

  it("reports status for valid PWA session tokens", async () => {
    const { route } = createPwaAuth({ secret: "test-secret" });
    const token = __test__.createToken("BoshiPOC", "test-secret");

    const ok = await request(route, "/pwa-auth/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ authenticated: true, account: "BoshiPOC" });

    const missing = await request(route, "/pwa-auth/status");
    expect(await missing.json()).toEqual({ authenticated: false });
  });

  it("exposes decoded PWA session metadata for route guards", () => {
    const auth = createPwaAuth({ secret: "test-secret" });
    const token = __test__.createToken("15207718306", "test-secret");
    expect(auth.getSession(token)).toMatchObject({ userId: "15207718306" });
    expect(auth.getSession("desktop-token")).toBeNull();
  });
});
