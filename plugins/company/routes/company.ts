// @ts-nocheck
import { routeError, strictJson } from "../../../server/hono-helpers.ts";
import { getCompanyService } from "../lib/company-service.ts";

async function readBody(c) {
  return await strictJson(c);
}

function statusForError(err) {
  return Number(err?.status) || 500;
}

export default function registerCompanyRoutes(app, ctx) {
  app.get("/companies", async (c) => {
    const companies = await getCompanyService(ctx).listCompanies();
    return c.json({ ok: true, companies });
  });

  app.post("/companies/default", async (c) => {
    try {
      const body = await readBody(c);
      const company = await getCompanyService(ctx).createDefaultCompany(body);
      return c.json({ ok: true, company });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.get("/companies/:id/status", async (c) => {
    try {
      const status = await getCompanyService(ctx).getStatus(c.req.param("id"));
      return c.json({ ok: true, ...status });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.post("/channels/bind", async (c) => {
    try {
      const body = await readBody(c);
      const channel = await getCompanyService(ctx).bindChannel(body);
      return c.json({ ok: true, channel });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.post("/channels/:id/messages", async (c) => {
    try {
      const body = await readBody(c);
      const result = await getCompanyService(ctx).ingestChannelMessage(c.req.param("id"), body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.post("/channels/:id/replies", async (c) => {
    try {
      const body = await readBody(c);
      const result = await getCompanyService(ctx).postChannelReply(c.req.param("id"), body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.patch("/channels/:id/status", async (c) => {
    try {
      const body = await readBody(c);
      const channel = await getCompanyService(ctx).updateChannelStatus(c.req.param("id"), body);
      return c.json({ ok: true, channel });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.post("/tasks/assign", async (c) => {
    try {
      const body = await readBody(c);
      const tasks = await getCompanyService(ctx).assignCommand(body);
      return c.json({ ok: true, tasks }, 202);
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.post("/tasks/assign-from-workflow", async (c) => {
    try {
      const body = await readBody(c);
      const result = await getCompanyService(ctx).assignFromCanvas({
        ...body,
        sourceType: "workflow_canvas",
      });
      return c.json({ ok: true, ...result }, 202);
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.post("/tasks/clear", async (c) => {
    try {
      const body = await readBody(c);
      const result = await getCompanyService(ctx).clearTasks(body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });

  app.patch("/tasks/:id/report", async (c) => {
    try {
      const body = await readBody(c);
      const task = await getCompanyService(ctx).reportTask({
        ...body,
        taskId: c.req.param("id"),
      });
      if (!task) return c.json({ ok: false, error: "task not found" }, 404);
      return c.json({ ok: true, task });
    } catch (err) {
      return routeError(c, err, statusForError(err));
    }
  });
}
