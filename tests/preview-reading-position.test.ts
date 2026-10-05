import { describe, expect, it } from "vitest";
import {
  normalizePreviewReadingPosition,
  normalizePreviewReadingPositions,
} from "../shared/preview-reading-position.ts";

describe("preview reading position normalization", () => {
  it("keeps bounded preview and edit scroll snapshots", () => {
    expect(normalizePreviewReadingPosition({
      preview: {
        scrollTop: 42,
        scrollLeft: 3,
        scrollHeight: 1000,
        clientHeight: 250,
        ratio: 0.5,
        anchorId: "intro",
        anchorText: "Intro",
        contentHash: "abc",
      },
      edit: {
        scrollTop: 12,
      },
      currentHeadingId: "intro",
      currentHeadingText: "Intro",
      contentHash: "abc",
    })).toEqual({
      preview: {
        scrollTop: 42,
        scrollLeft: 3,
        scrollHeight: 1000,
        clientHeight: 250,
        ratio: 0.5,
        anchorId: "intro",
        anchorText: "Intro",
        contentHash: "abc",
      },
      edit: {
        scrollTop: 12,
      },
      currentHeadingId: "intro",
      currentHeadingText: "Intro",
      contentHash: "abc",
    });
  });

  it("drops invalid ids and unknown preview tabs", () => {
    expect(normalizePreviewReadingPositions({
      "tab-a": { preview: { scrollTop: 10 } },
      "tab-b": { preview: { scrollTop: -1 } },
      "tab-c": { currentHeadingId: "chapter" },
    }, ["tab-a", "tab-c"])).toEqual({
      "tab-a": { preview: { scrollTop: 10 } },
      "tab-c": { currentHeadingId: "chapter" },
    });
  });
});
