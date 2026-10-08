// @ts-nocheck
import { strictJson, routeError } from "../../../server/hono-helpers.ts";
import { execute } from "../tools/generate-video.ts";

function resolveSessionPath(c, body) {
  return c.req.header("X-gsap-Session-Path")
    || c.req.header("X-GSAP-Session-Path")
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

export default function registerGenerateVideoRoute(app, ctx) {
  app.post("/generate-video", async (c) => {
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
        duration: body.duration,
        ratio: body.ratio,
        aspect_ratio: body.aspect_ratio,
        generateAudio: body.generateAudio,
        generate_audio: body.generate_audio,
        audio: body.audio,
        watermark: body.watermark,
        resolution: body.resolution,
        action: body.action,
        negative_prompt: body.negative_prompt,
        negativePrompt: body.negativePrompt,
        prompt_extend: body.prompt_extend,
        promptExtend: body.promptExtend,
        shot_type: body.shot_type,
        shotType: body.shotType,
        reference_urls: arrayOrUndefined(body.reference_urls),
        referenceUrls: arrayOrUndefined(body.referenceUrls),
        seed: body.seed,
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
          error: details.error.message || details.error.code || firstText(result, "Video generation failed"),
          content: result.content || [],
          details,
        }, 500);
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
