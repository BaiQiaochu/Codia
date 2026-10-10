import { describe, expect, it } from "vitest";
import { buildCardDocument } from "../server/cards/card-document.ts";

describe("buildCardDocument", () => {
  it("injects generated card code into a standalone document", () => {
    const code = '<button id="go" onclick="window.clicked=true">开始</button>';
    const html = buildCardDocument({ code });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<body>");
    expect(html).toContain(code);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("injects theme variables while keeping base typography available", () => {
    const html = buildCardDocument({
      code: "<div>card</div>",
      varsCss: "  --accent: #537D96;\n  --bg-card: #FCFAF5;",
    });

    expect(html).toContain("--accent: #537D96;");
    expect(html).toContain("--bg-card: #FCFAF5;");
    expect(html).toContain("--font-serif:");
    expect(html).toContain("--font-mono:");
  });

  it("contains the resize/ping protocol needed by the iframe host", () => {
    const html = buildCardDocument({ code: "<div>x</div>" });

    expect(html).toContain("codia.card-resize");
    expect(html).toContain("codia.card-ping");
    expect(html).toContain("ResizeObserver");
  });

  it("sanitizes angle brackets from varsCss to prevent style tag injection", () => {
    const html = buildCardDocument({
      code: "<div>x</div>",
      varsCss: "--x: 1;</style><script>steal()</script>",
    });
    const head = html.slice(0, html.indexOf("</head>"));

    expect(head.match(/<\/style>/g)?.length).toBe(1);
    expect(head).not.toContain("<script");
  });
});
