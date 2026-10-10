import { describe, expect, it } from "vitest";

import {
  createBridgePresentation,
  FEISHU_CARDKIT_STREAM_ELEMENT_ID,
  renderFeishuCardKitCard,
  renderFeishuCardKitSettings,
  renderTelegramRichMessage,
} from "../lib/bridge/bridge-presentation.ts";

describe("bridge presentation renderers", () => {
  it("keeps rich markdown as the canonical bridge presentation", () => {
    const presentation = createBridgePresentation([
      "# Summary",
      "",
      "| Item | State |",
      "| --- | --- |",
      "| Tool | done |",
      "",
      "<details><summary>Trace</summary>tool output</details>",
    ].join("\n"));

    expect(presentation).toMatchObject({
      kind: "bridge_presentation",
      format: "markdown",
    });
    expect(presentation.markdown).toContain("| Tool | done |");
    expect(presentation.markdown).toContain("<details><summary>Trace</summary>tool output</details>");
  });

  it("renders Telegram rich messages as InputRichMessage markdown", () => {
    const richMessage = renderTelegramRichMessage("**bold**\n\n<details><summary>More</summary>x</details>");

    expect(richMessage).toEqual({
      markdown: "**bold**\n\n<details><summary>More</summary>x</details>",
    });
  });

  it("renders Telegram rich draft placeholders with the documented tg-thinking tag", () => {
    const richMessage = renderTelegramRichMessage("", {
      includeThinkingPlaceholder: true,
      thinkingText: "Codia <thinking>",
    });

    expect(richMessage).toEqual({
      html: "<tg-thinking>Codia &lt;thinking&gt;</tg-thinking>",
    });
  });

  it("renders Feishu CardKit JSON 2.0 markdown cards and settings strings", () => {
    const card = renderFeishuCardKitCard("stream text");

    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true },
      body: {
        elements: [{
          tag: "markdown",
          element_id: FEISHU_CARDKIT_STREAM_ELEMENT_ID,
          content: "stream text",
        }],
      },
    });
    expect(renderFeishuCardKitSettings(true)).toBe(JSON.stringify({ streaming_mode: true }));
    expect(renderFeishuCardKitSettings(false)).toBe(JSON.stringify({ streaming_mode: false }));
  });
});
