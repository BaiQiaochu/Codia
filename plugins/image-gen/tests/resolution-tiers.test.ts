import { describe, expect, it } from "vitest";
import { resolveOpenAiImageSize } from "../lib/resolution-tiers.ts";

describe("OpenAI image resolution tiers", () => {
  it("maps generic tiers and ratios to supported flexible OpenAI sizes", () => {
    expect(resolveOpenAiImageSize(
      { resolution: "4K", ratio: "16:9" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toBe("3840x2160");

    expect(resolveOpenAiImageSize(
      { resolution: "4k", ratio: "1:1" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toBe("2880x2880");

    expect(resolveOpenAiImageSize(
      { resolution: "2K", ratio: "3:2" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toBe("2048x1360");
  });

  it("normalizes explicit pixel sizes without accepting impossible OpenAI sizes", () => {
    expect(resolveOpenAiImageSize(
      { size: "2048*2048" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toBe("2048x2048");

    expect(() => resolveOpenAiImageSize(
      { size: "4096x4096" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toThrow(/G-SAP image size/i);
  });

  it("keeps older fixed-size OpenAI models on their standard size table", () => {
    expect(resolveOpenAiImageSize(
      { resolution: "4k", ratio: "16:9" },
      {},
      { sourceName: "OpenAI image", flexible: false },
    )).toBe("1536x1024");
  });

  it("keeps ratio-only requests on the nearest standard OpenAI size", () => {
    expect(resolveOpenAiImageSize(
      { ratio: "21:9" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toBe("1536x1024");
  });

  it("rejects ratios outside the shared image generation contract", () => {
    expect(() => resolveOpenAiImageSize(
      { resolution: "2k", ratio: "5:4" },
      {},
      { sourceName: "G-SAP image", flexible: true },
    )).toThrow(/G-SAP image ratio/i);
  });
});
