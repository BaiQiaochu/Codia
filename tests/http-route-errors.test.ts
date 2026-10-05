import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpRouteError, jsonRouteError } from "../server/http/route-errors.js";

describe("HTTP route errors", () => {
  it("serializes HttpRouteError responses with code, message, and trace id", async () => {
    const app = new Hono();
    app.get("/error", (c) => jsonRouteError(c, new HttpRouteError({
      code: "desk_unavailable",
      message: "Desk not initialized",
      status: 503,
      traceId: "trace-1",
    })));

    const res = await app.request("/error");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "desk_unavailable",
        message: "Desk not initialized",
        traceId: "trace-1",
      },
    });
  });

  it("serializes route error options without a trace id", async () => {
    const app = new Hono();
    app.get("/error", (c) => jsonRouteError(c, {
      code: "bad_request",
      message: "name required",
      status: 400,
    }));

    const res = await app.request("/error");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "bad_request",
        message: "name required",
      },
    });
  });

  it("throws for invalid route error codes", () => {
    expect(() => new HttpRouteError({
      code: "",
      message: "bad request",
      status: 400,
    })).toThrow(TypeError);

    const c = { json: vi.fn() };
    expect(() => jsonRouteError(c, {
      code: " ",
      message: "bad request",
      status: 400,
    })).toThrow(TypeError);
  });

  it("throws for invalid or empty route error messages", () => {
    expect(() => new HttpRouteError({
      code: "bad_request",
      message: "",
      status: 400,
    })).toThrow(TypeError);

    expect(() => jsonRouteError({ json: vi.fn() }, {
      code: "bad_request",
      message: 42,
      status: 400,
    } as any)).toThrow(TypeError);
  });

  it("throws for invalid route error statuses", () => {
    expect(() => new HttpRouteError({
      code: "bad_request",
      message: "bad request",
      status: 200 as any,
    })).toThrow(TypeError);

    expect(() => jsonRouteError({ json: vi.fn() }, {
      code: "bad_request",
      message: "bad request",
      status: 500.5 as any,
    })).toThrow(TypeError);
  });
});
