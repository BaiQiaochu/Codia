import { describe, expect, it } from "vitest";
import { getYuanVisual, moodLabelForYuan, normalizeYuan } from "../shared/yuan-visuals.ts";

describe("yuan visuals", () => {
  const defaultAssistantAvatar = "character-cards/gsap-default-avatar.png";

  it("keeps G-SAP yuan visuals debranded", () => {
    expect(getYuanVisual("gsap")).toMatchObject({
      symbol: "\u2699",
      moodLabel: "MOOD",
      accent: "#537D96",
      avatar: defaultAssistantAvatar,
    });
    expect(getYuanVisual("butter")).toMatchObject({
      symbol: "\u2665",
      moodLabel: "PULSE",
      accent: "#5BA88C",
      avatar: defaultAssistantAvatar,
    });
    expect(getYuanVisual("ming")).toMatchObject({
      symbol: "\u25C6",
      moodLabel: "REFLECT",
      accent: "#8BA4B4",
      avatar: defaultAssistantAvatar,
    });
    expect(getYuanVisual("kong").avatar).toBe(defaultAssistantAvatar);
  });

  it("falls back to gsap for unknown yuan values", () => {
    expect(normalizeYuan("unknown")).toBe("gsap");
    expect(moodLabelForYuan("unknown")).toBe("\u2699 MOOD");
  });
});
