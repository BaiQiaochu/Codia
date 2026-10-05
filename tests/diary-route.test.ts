import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDiaryRoute } from "../server/routes/diary.ts";

describe("diary route", () => {
  function makeApp(engine: any) {
    const app = new Hono();
    app.route("/api", createDiaryRoute(engine));
    return app;
  }

  it("keeps the legacy no-body diary write contract", async () => {
    const engine = {
      writeDiary: vi.fn().mockResolvedValue({
        filePath: "/tmp/diary.md",
        content: "# diary",
        logicalDate: "2026-05-07",
      }),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/diary/write", { method: "POST" });

    expect(res.status).toBe(200);
    expect(engine.writeDiary).toHaveBeenCalledWith({ targetDate: undefined });
  });

  it("passes an explicit targetDate to the diary writer", async () => {
    const engine = {
      writeDiary: vi.fn().mockResolvedValue({
        filePath: "/tmp/diary.md",
        content: "# diary",
        logicalDate: "2026-05-06",
      }),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/diary/write", {
      method: "POST",
      body: JSON.stringify({ targetDate: "2026-05-06" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(engine.writeDiary).toHaveBeenCalledWith({ targetDate: "2026-05-06" });
  });
});
