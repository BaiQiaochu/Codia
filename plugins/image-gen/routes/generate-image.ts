// @ts-nocheck
import { strictJson, routeError } from "../../../server/hono-helpers.ts";
import { execute } from "../tools/generate-image.ts";

function resolveSessionPath(c, body) {
  return c.req.header("X-codia-Session-Path")
    || c.req.header("X-CODIA-Session-Path")
    || c.req.query("sessionPath")
    || body?.sessionPath
    || null;
}

function arrayOrUndefined(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return undefined;
  return [value];
}

function firstText(result, fallback) {
  if (!Array.isArray(result?.content)) return fallback;
  const text = result.content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || fallback;
}

function mediaErrorStatus(code) {
  if (code === "missing_credentials") return 401;
  if (code === "missing_model") return 409;
  if (code === "not_initialized") return 503;
  if (code === "provider_failure" || code === "task_failed") return 502;
  return 400;
}

export default function registerGenerateImageRoute(app, ctx) {
  app.post("/generate-image", async (c) => {
    let body;
    try {
      body = await strictJson(c);
    } catch (err) {
      return routeError(c, err);
    }

    const prompt = String(body?.prompt || "").trim();
    if (!prompt) return c.json({ error: "prompt is required" }, 400);

    try {
      const result = await execute({
        prompt,
        provider: body.provider,
        model: body.model,
        image: body.image,
        images: arrayOrUndefined(body.images),
        count: body.count,
        ratio: body.ratio,
        aspect_ratio: body.aspect_ratio,
        resolution: body.resolution,
        size: body.size,
        quality: body.quality,
        suggestedFilename: body.suggestedFilename || body.suggested_filename,
        filename: body.filename,
      }, {
        ...ctx,
        agentId: c.get("agentId") || body.agentId || ctx.agentId,
        sessionPath: resolveSessionPath(c, body) || ctx.sessionPath,
      });

      const card = result?.details?.card
        ? { pluginId: ctx.pluginId || "image-gen", ...result.details.card }
        : undefined;
      const details = card ? { ...(result.details || {}), card } : result.details || {};

      if (details?.error) {
        return c.json({
          ok: false,
          error: details.error.message || details.error.code || firstText(result, "Image generation failed"),
          content: result.content || [],
          details,
        }, mediaErrorStatus(details.error.code));
      }

      return c.json({
        ok: true,
        content: result.content || [],
        details,
      });
    } catch (err) {
      return c.json({ ok: false, error: err?.message || String(err) }, 500);
    }
  });
}
