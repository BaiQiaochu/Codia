// @ts-nocheck
import { Type } from "@sinclair/typebox";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { t } from "../i18n.ts";
import { htmlToMarkdownDocument } from "./web-reader.ts";

const MAX_CONTENT_LENGTH = 12000;
const FETCH_TIMEOUT = 15000;
const MAX_REDIRECTS = 5;

const PRIVATE_IP_RANGES = [
  /^127\./, /^::1$/, /^0\.0\.0\.0$/, /^0:0:0:0:0:0:0:1$/,
  /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^fe80:/i,
  /^fc00:/i, /^fd[0-9a-f]{2}:/i,
];

async function isPrivateHost(hostname) {
  if (isIP(hostname)) return PRIVATE_IP_RANGES.some((pattern) => pattern.test(hostname));
  try {
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) return true;
    return results.some((entry) => PRIVATE_IP_RANGES.some((pattern) => pattern.test(entry.address)));
  } catch {
    return true;
  }
}

function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article|header)[^>]*>/gi, "\n");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function createWebFetchTool() {
  return {
    name: "web_fetch",
    label: t("toolDef.webFetch.label"),
    description: t("toolDef.webFetch.description"),
    parameters: Type.Object({
      url: Type.String({ description: t("toolDef.webFetch.urlDesc") }),
      maxLength: Type.Optional(
        Type.Number({ description: t("toolDef.webFetch.maxLenDesc", { max: MAX_CONTENT_LENGTH }), default: MAX_CONTENT_LENGTH }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const url = params.url?.trim();
      if (!url) {
        return {
          content: [{ type: "text", text: t("error.fetchEmptyUrl") }],
          details: {},
        };
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return {
            content: [{ type: "text", text: t("error.fetchHttpOnly") }],
            details: {},
          };
        }
      } catch {
        return {
          content: [{ type: "text", text: t("error.fetchInvalidUrl", { url }) }],
          details: {},
        };
      }

      try {
        let currentUrl = url;
        let res;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          const hopParsed = new URL(currentUrl);
          if (await isPrivateHost(hopParsed.hostname)) {
            return {
              content: [{ type: "text", text: t("error.fetchSsrf", { host: hopParsed.hostname }) }],
              details: {},
            };
          }

          res = await fetch(currentUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; GSAPBot/1.0)",
              "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
              "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
          });

          if ([301, 302, 307, 308].includes(res.status)) {
            const location = res.headers.get("location");
            if (!location) break;
            currentUrl = new URL(location, currentUrl).href;
            continue;
          }
          break;
        }

        if (!res || [301, 302, 307, 308].includes(res.status)) {
          return {
            content: [{ type: "text", text: t("error.fetchRedirectLimit", { max: MAX_REDIRECTS }) }],
            details: {},
          };
        }

        if (!res.ok) {
          return {
            content: [{ type: "text", text: t("error.fetchHttpError", { status: res.status, statusText: res.statusText }) }],
            details: {},
          };
        }

        const contentType = res.headers.get("content-type") || "";
        const raw = await res.text();
        const maxLen = params.maxLength ?? MAX_CONTENT_LENGTH;
        let text;
        let format;

        if (contentType.includes("application/json")) {
          try {
            text = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            text = raw;
          }
          format = "json";
        } else if (contentType.includes("text/html")) {
          try {
            const doc = await htmlToMarkdownDocument(raw, currentUrl);
            text = doc.content || htmlToText(raw);
            format = "markdown";
          } catch {
            text = htmlToText(raw);
            format = "html->text";
          }
        } else {
          text = raw;
          format = "text";
        }

        const originalLength = text.length;
        if (text.length > maxLen) {
          text = text.slice(0, maxLen) + t("error.fetchTruncated", { len: originalLength });
        }

        const finalUrl = new URL(currentUrl);
        const header = t("error.fetchSource", { host: finalUrl.hostname, path: finalUrl.pathname, format });
        return {
          content: [{ type: "text", text: header + text }],
          details: {},
        };
      } catch (err) {
        const msg = err.name === "TimeoutError"
          ? t("error.fetchTimeout", { sec: FETCH_TIMEOUT / 1000, url })
          : t("error.fetchError", { msg: err.message });
        return {
          content: [{ type: "text", text: msg }],
          details: {},
        };
      }
    },
  };
}
