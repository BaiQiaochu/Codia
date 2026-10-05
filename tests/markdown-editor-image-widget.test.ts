import { describe, expect, it } from "vitest";
import { splitMarkdownImageSource } from "../desktop/src/react/editor/widgets/image.ts";

describe("markdown editor image widget", () => {
  it("parses image destinations that contain spaces, titles, and parentheses", () => {
    expect(splitMarkdownImageSource('![cover](./assets/bird (final).png "cover image")')).toEqual({
      alt: "cover",
      rawUrl: "./assets/bird (final).png",
    });
  });

  it("parses angle-bracket image destinations without treating spaces as titles", () => {
    expect(splitMarkdownImageSource("![设计图](<./视觉设计/image 1.png>)")).toEqual({
      alt: "设计图",
      rawUrl: "./视觉设计/image 1.png",
    });
  });
});
