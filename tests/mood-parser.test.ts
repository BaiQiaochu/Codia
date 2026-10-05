import { describe, expect, it } from "vitest";
import { MoodParser } from "../core/events.js";

function collectMoodEvents(chunks) {
  const parser = new MoodParser();
  const events = [];
  for (const chunk of chunks) {
    parser.feed(chunk, (event) => events.push(event));
  }
  parser.flush((event) => events.push(event));
  return events;
}

describe("MoodParser", () => {
  it("parses uppercase MOOD tags", () => {
    expect(collectMoodEvents(["<MOOD>hidden</MOOD>\nvisible"])).toEqual([
      { type: "mood_start" },
      { type: "mood_text", data: "hidden" },
      { type: "mood_end" },
      { type: "text", data: "visible" },
    ]);
  });

  it("parses chunked MOD tags as MOOD-compatible blocks", () => {
    expect(collectMoodEvents(["<M", "OD>hidden</", "MOD>\nvisible"])).toEqual([
      { type: "mood_start" },
      { type: "mood_text", data: "hidden" },
      { type: "mood_end" },
      { type: "text", data: "visible" },
    ]);
  });
});
