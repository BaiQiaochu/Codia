import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { buildCardDocument } from "../cards/card-document.ts";

const MAX_CARDS = 256;
const MAX_CODE_BYTES = 512 * 1024;
const MAX_VARS_BYTES = 16 * 1024;
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface CardEntry {
  code: string;
  varsCss: string;
}

export function createCardsRoute(_engine: unknown) {
  const route = new Hono();
  const cache = new Map<string, CardEntry>();

  function touch(cardId: string, entry: CardEntry) {
    if (cache.has(cardId)) cache.delete(cardId);
    cache.set(cardId, entry);
    while (cache.size > MAX_CARDS) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  route.put("/cards/:cardId", async (c) => {
    const cardId = c.req.param("cardId");
    if (!CARD_ID_RE.test(cardId)) return c.json({ error: "invalid cardId" }, 400);

    const body = await safeJson(c) as { code?: unknown; varsCss?: unknown };
    const code = typeof body?.code === "string" ? body.code : "";
    if (!code) return c.json({ error: "code required" }, 400);
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
      return c.json({ error: "code too large" }, 413);
    }

    let varsCss = typeof body?.varsCss === "string" ? body.varsCss : "";
    if (Buffer.byteLength(varsCss, "utf8") > MAX_VARS_BYTES) varsCss = "";
    touch(cardId, { code, varsCss });
    return c.json({ ok: true });
  });

  route.get("/cards/:cardId", (c) => {
    const cardId = c.req.param("cardId");
    if (!CARD_ID_RE.test(cardId)) return c.text("invalid cardId", 400);

    const entry = cache.get(cardId);
    if (!entry) return c.text("card not found", 404);

    cache.delete(cardId);
    cache.set(cardId, entry);

    const html = buildCardDocument({ code: entry.code, varsCss: entry.varsCss });
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(html);
  });

  return route;
}
