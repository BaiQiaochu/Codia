import { describe, expect, it, vi } from "vitest";
import { promptAttachedDesktopSession } from "../../core/slash-commands/rc-router.js";

function makeFakeSession({ model = null, deltas = ["ok"], events = [] } = {}) {
  const subscribers = [];
  return {
    model,
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    prompt: vi.fn(async () => {
      for (const delta of deltas) {
        for (const fn of subscribers) {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
        }
      }
      for (const event of events) {
        for (const fn of subscribers) fn(event);
      }
    }),
    _subscribers: subscribers,
  };
}

function makeEngine(session) {
  return {
    ensureSessionLoaded: vi.fn(async () => session),
  };
}

describe("promptAttachedDesktopSession", () => {
  it("appends settings update summaries into captured text", async () => {
    const session = makeFakeSession({
      events: [{
        type: "tool_execution_end",
        isError: false,
        result: {
          details: {
            settingsUpdate: {
              status: "applied",
              action: "core.apply",
              key: "locale",
              title: "Locale updated",
              summary: "Locale changed.",
              changes: [{ key: "locale", label: "Locale", before: "zh-CN", after: "en" }],
            },
          },
        },
      }],
    });
    const result = await promptAttachedDesktopSession(makeEngine(session), "/p.jsonl", "q");

    expect(result.text).toContain("Locale updated");
    expect(result.text).toContain("Locale: zh-CN -> en");
  });

  it("passes images when the active model supports direct image input", async () => {
    const session = makeFakeSession({
      model: { id: "gpt-4o", provider: "openai", api: "openai-completions", input: ["text", "image"] },
    });

    await promptAttachedDesktopSession(makeEngine(session), "/p.jsonl", "q", {
      images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });

    expect(session.prompt).toHaveBeenCalledWith("q", {
      images: [expect.objectContaining({ mimeType: "image/png" })],
    });
  });

  it("strips images when the active model declares image input but cannot transport it directly", async () => {
    const session = makeFakeSession({
      model: {
        id: "deepseek-vl",
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        input: ["text", "image"],
      },
    });

    await promptAttachedDesktopSession(makeEngine(session), "/p.jsonl", "q", {
      images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });

    expect(session.prompt).toHaveBeenCalledWith("q", undefined);
  });
});
