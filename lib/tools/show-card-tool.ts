import { Type } from "../pi-sdk/index.ts";
import { toolOk } from "./tool-result.ts";

let cardSeq = 0;

function generateCardId(): string {
  cardSeq += 1;
  const ts = Date.now().toString(36);
  const seq = cardSeq.toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `c_${ts}_${seq}_${rand}`;
}

export function createShowCardTool() {
  return {
    name: "show_card",
    label: "Interactive Card",
    description:
      "Render visual HTML/SVG content inline in the conversation as an interactive card. " +
      "Use for diagrams, dashboards, tables, timelines, small calculators, and structured visual explanations. " +
      "Do not include DOCTYPE, html, head, or body tags. Call codia_card_guide before the first show_card call.",
    parameters: Type.Object({
      title: Type.String({
        description:
          "Short snake_case identifier. It should distinguish this visual if the conversation has multiple cards.",
      }),
      code: Type.String({
        description:
          "HTML or SVG fragment to render. Use CSS variables such as --accent, --text, --bg-card, and --border.",
      }),
    }),
    progress: "Rendering card",
    execute: async (_toolCallId: string, params: { title: string; code: string }) => {
      const title = typeof params?.title === "string" ? params.title : "";
      const code = typeof params?.code === "string" ? params.code : "";
      const cardId = generateCardId();

      return toolOk(`Card "${title}" rendered.`, {
        cardId,
        title,
        code,
        status: "rendered",
      });
    },
  };
}
