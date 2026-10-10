// @ts-nocheck
import path from "node:path";
import { routeError, strictJson } from "../../../server/hono-helpers.ts";
import { parseDesignDocumentPreview } from "../../../shared/design-document-preview.ts";
import {
  collectExplicitMindmapInput,
  generateMindmapFromDocument,
  resolveMindMapOutputDir,
  sanitizeXmindName,
  uniqueFileName,
} from "../lib/mind-map-operations.ts";
import { MindMapStore } from "../lib/mind-map-store.ts";
import { renderMindMapHtml } from "../lib/render-mind-map-html.ts";

function getStore(ctx) {
  if (ctx._mindMap?.store) return ctx._mindMap.store;
  const store = new MindMapStore(ctx.dataDir);
  ctx._mindMap = { ...(ctx._mindMap || {}), store };
  return store;
}

function badRequest(c, message) {
  return c.json({ error: message }, 400);
}

async function jsonBody(c) {
  return await strictJson(c);
}

export default function registerMindMapRoutes(app, ctx) {
  app.get("/page", (c) => {
    const themeCss = c.req.query("codia-css") || "";
    const token = c.req.query("token") || c.req.query("api_key") || c.req.query("apikey") || "";
    const filePath = c.req.query("path") || c.req.query("filePath") || "";
    return c.html(renderMindMapHtml({ mode: "page", themeCss, token, filePath }));
  });

  app.get("/card", (c) => {
    const themeCss = c.req.query("codia-css") || "";
    const token = c.req.query("token") || c.req.query("api_key") || c.req.query("apikey") || "";
    const filePath = c.req.query("path") || "";
    return c.html(renderMindMapHtml({ mode: "card", themeCss, token, filePath }));
  });

  app.get("/tree", (c) => {
    const filePath = c.req.query("path") || c.req.query("filePath") || "";
    if (!filePath) return badRequest(c, "path is required");
    try {
      return c.json(getStore(ctx).read(filePath));
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  app.get("/preview", async (c) => {
    const filePath = c.req.query("path") || c.req.query("filePath") || "";
    if (!filePath) return badRequest(c, "path is required");
    try {
      const preview = await parseDesignDocumentPreview(filePath);
      const tree = getStore(ctx).read(filePath).root;
      return c.json({ ok: true, preview, tree });
    } catch (err) {
      return routeError(c, err, err?.status || 400);
    }
  });

  app.post("/generate", async (c) => {
    let body;
    try {
      body = await jsonBody(c);
    } catch (err) {
      return routeError(c, err);
    }

    const store = getStore(ctx);
    const outputDir = resolveMindMapOutputDir(body, ctx);

    try {
      const explicit = await collectExplicitMindmapInput(body);
      if (!explicit) {
        const title = String(body?.title || "Mind Map").trim() || "Mind Map";
        const filePath = store.createBlank(sanitizeXmindName(body?.name || title), title, { dir: outputDir });
        return c.json({ ok: true, ...store.read(filePath) });
      }

      const sourceBase = explicit.sourcePath
        ? path.basename(explicit.sourcePath)
        : String(body?.name || explicit.title || "Mind Map");
      const fileName = uniqueFileName(outputDir, sanitizeXmindName(body?.name || sourceBase));
      const filePath = path.join(outputDir, fileName);
      const root = await generateMindmapFromDocument(ctx, explicit.title, explicit.text, { log: ctx.log });
      store.createFromTree(filePath, root);
      return c.json({ ok: true, filePath, fileName, root: store.read(filePath).root });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  app.post("/save", async (c) => {
    let body;
    try {
      body = await jsonBody(c);
    } catch (err) {
      return routeError(c, err);
    }
    const filePath = String(body?.path || body?.filePath || "").trim();
    const root = body?.root || body?.tree;
    if (!filePath) return badRequest(c, "path is required");
    if (!root) return badRequest(c, "root is required");
    try {
      return c.json({ ok: true, ...getStore(ctx).write(filePath, root) });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  app.post("/nodes", async (c) => {
    let body;
    try {
      body = await jsonBody(c);
    } catch (err) {
      return routeError(c, err);
    }
    const filePath = String(body?.path || body?.filePath || "").trim();
    const parentId = String(body?.parentId || "").trim();
    if (!filePath) return badRequest(c, "path is required");
    if (!parentId) return badRequest(c, "parentId is required");
    try {
      return c.json({ ok: true, ...getStore(ctx).addNode(filePath, parentId, body?.title) });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  app.patch("/nodes/:id", async (c) => {
    let body;
    try {
      body = await jsonBody(c);
    } catch (err) {
      return routeError(c, err);
    }
    const filePath = String(body?.path || body?.filePath || "").trim();
    if (!filePath) return badRequest(c, "path is required");
    try {
      return c.json({ ok: true, ...getStore(ctx).renameNode(filePath, c.req.param("id"), body?.title) });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });

  app.delete("/nodes/:id", async (c) => {
    let body = {};
    try {
      body = await jsonBody(c);
    } catch (err) {
      return routeError(c, err);
    }
    const filePath = String(body?.path || body?.filePath || c.req.query("path") || "").trim();
    if (!filePath) return badRequest(c, "path is required");
    try {
      return c.json({ ok: true, ...getStore(ctx).deleteNode(filePath, c.req.param("id")) });
    } catch (err) {
      return routeError(c, err, 400);
    }
  });
}
