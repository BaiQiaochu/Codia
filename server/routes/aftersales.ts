import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { getAfterSalesService } from "../../lib/aftersales/index.ts";

export function createAfterSalesRoute(engine) {
  const route = new Hono();
  const service = getAfterSalesService(engine.gsapHome, debugLog());

  route.get("/aftersales/status", async (c) => {
    try {
      return c.json(service.getStatus());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/aftersales/config", async (c) => {
    try {
      return c.json(service.getConfig());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/aftersales/config", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const config = service.updateConfig(body);
      return c.json({ ok: true, config });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/aftersales/tasks", async (c) => {
    try {
      const status = c.req.query("status") || "";
      const limit = Number(c.req.query("limit") || 100);
      return c.json({
        tasks: service.listTasks({
          status: status || undefined,
          limit: Number.isFinite(limit) ? limit : 100,
        }),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/aftersales/tasks/:id", async (c) => {
    try {
      const task = service.getTask(c.req.param("id"));
      if (!task) return c.json({ error: "task not found" }, 404);
      return c.json({ task });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/aftersales/parse-message", async (c) => {
    try {
      const body = await safeJson(c);
      if (typeof body?.text !== "string") {
        return c.json({ error: "text is required" }, 400);
      }
      return c.json(service.parseMessage(body));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/aftersales/tasks/from-message", async (c) => {
    try {
      const body = await safeJson(c);
      if (typeof body?.text !== "string") {
        return c.json({ error: "text is required" }, 400);
      }
      const result = service.createTaskFromMessage(body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/aftersales/tasks", async (c) => {
    try {
      const body = await safeJson(c);
      const task = service.createTask(body || {});
      return c.json({ ok: true, task });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/aftersales/tasks/:id/run", async (c) => {
    try {
      const task = await service.runTask(c.req.param("id"));
      return c.json({ ok: true, task });
    } catch (err) {
      return c.json({ error: err.message }, err.message.includes("not found") ? 404 : 500);
    }
  });

  return route;
}
