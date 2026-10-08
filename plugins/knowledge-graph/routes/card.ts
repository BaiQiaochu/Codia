// @ts-nocheck
import { renderGraphHtml } from "../lib/render-graph-html.ts";

export default function (app) {
  app.get("/card", (c) => {
    const gsapCss = c.req.query("gsap-css") || "";
    const token = c.req.query("token") || c.req.query("api_key") || c.req.query("apikey") || "";
    return c.html(renderGraphHtml({ mode: "card", gsapCss, token }));
  });
}