import { describe, expect, it } from "vitest";
import {
  createColorPalette,
  drawCliCardToString,
  fitText,
  padRight,
  stripAnsi,
  textWidth,
} from "../lib/cli/render.ts";

describe("CLI render helpers", () => {
  it("counts Chinese characters as double-width and strips ANSI before measuring", () => {
    const color = createColorPalette(true);
    expect(stripAnsi(`${color.cyan}模型${color.reset}`)).toBe("模型");
    expect(textWidth("模型")).toBe(4);
    expect(textWidth(`${color.cyan}模型${color.reset}`)).toBe(4);
  });

  it("fits and pads plain text without breaking ANSI-colored text", () => {
    expect(fitText("abcdef", 5)).toBe("ab...");
    expect(padRight("模型", 6)).toBe("模型  ");
    const colored = "\x1b[36mabcdef\x1b[0m";
    expect(fitText(colored, 5)).toBe(colored);
  });

  it("renders a fixed-width card as a string for tests and CLI output", () => {
    const card = drawCliCardToString(["G-SAP CLI", "模型: ask"], 24);
    expect(card).toContain("╭");
    expect(card).toContain("G-SAP CLI");
    expect(card.split("\n").filter(Boolean)).toHaveLength(4);
  });
});
