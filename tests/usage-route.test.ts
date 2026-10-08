// @ts-nocheck
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createUsageRoute } from "../server/routes/usage.js";

describe("usage route", () => {
  it("does not apply the latest-500 default cap to explicit date-window queries", async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({
      requestId: `req-${index + 1}`,
      startedAt: "2026-05-20T00:00:00.000Z",
      endedAt: "2026-05-20T00:00:01.000Z",
    }));
    const app = new Hono();
    const engine = {
      usageLedger: {
        list: (filter = {}) => ({
          entries: filter.limit ? entries.slice(-filter.limit) : entries,
          nextCursor: null,
        }),
      },
    };

    app.route("/api", createUsageRoute(engine));

    const res = await app.request("/api/usage/llm?since=2026-05-20T00%3A00%3A00.000Z&until=2026-05-21T00%3A00%3A00.000Z");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(600);
  });

  it("keeps invalid explicit limits bounded unless the caller asks for all entries", async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({ requestId: `req-${index + 1}` }));
    const app = new Hono();
    const engine = {
      usageLedger: {
        list: (filter = {}) => ({
          entries: filter.limit ? entries.slice(-filter.limit) : entries,
          nextCursor: null,
        }),
      },
    };

    app.route("/api", createUsageRoute(engine));

    const invalid = await app.request("/api/usage/llm?limit=abc");
    const invalidBody = await invalid.json();
    const all = await app.request("/api/usage/llm?limit=all");
    const allBody = await all.json();

    expect(invalid.status).toBe(200);
    expect(invalidBody.entries).toHaveLength(500);
    expect(all.status).toBe(200);
    expect(allBody.entries).toHaveLength(600);
  });
});
