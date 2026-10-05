import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCardsRoute } from "../server/routes/cards.ts";

function buildApp() {
  const app = new Hono();
  app.route("/api", createCardsRoute({}));
  return app;
}

function putCard(app: Hono, cardId: string, body: Record<string, unknown>) {
  return app.request(`/api/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cards route", () => {
  it("registers card code and serves it as CSP-free HTML", async () => {
    const app = buildApp();
    const code = '<button onclick="x()">开始</button>';

    const put = await putCard(app, "c_abc123", {
      code,
      title: "workspace_card",
      varsCss: "--accent: #537D96;",
    });
    expect(put.status).toBe(200);

    const get = await app.request("/api/cards/c_abc123");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    expect(get.headers.get("content-security-policy")).toBeNull();

    const html = await get.text();
    expect(html).toContain(code);
    expect(html).toContain("--accent: #537D96;");
  });

  it("rejects invalid card ids, missing code, and oversized card code", async () => {
    const app = buildApp();

    expect((await putCard(app, "bad id!", { code: "<div>x</div>" })).status).toBe(400);
    expect((await app.request("/api/cards/bad%20id!")).status).toBe(400);
    expect((await putCard(app, "c_nocode", { title: "x" })).status).toBe(400);
    expect((await putCard(app, "c_huge", { code: "x".repeat(512 * 1024 + 1) })).status).toBe(413);
  });

  it("returns 404 for unknown cards and evicts oldest cards after capacity", async () => {
    const app = buildApp();

    expect((await app.request("/api/cards/c_missing")).status).toBe(404);
    for (let i = 0; i < 257; i += 1) {
      expect((await putCard(app, `c_${i}`, { code: `<div>${i}</div>` })).status).toBe(200);
    }

    expect((await app.request("/api/cards/c_0")).status).toBe(404);
    expect((await app.request("/api/cards/c_256")).status).toBe(200);
  });
});
