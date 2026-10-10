import { describe, expect, it, vi } from "vitest";
import {
  runVisionContextInjection,
  VISION_CONTEXT_INJECTION_FAILED,
} from "../core/vision-context-injector.js";
import { VISION_CONTEXT_START } from "../core/vision-bridge.js";

describe("VisionContextInjector", () => {
  it("returns structured diagnostics instead of silently running blind when injection fails", async () => {
    const warn = vi.fn();
    const result = await runVisionContextInjection({
      path: "codia-test-vision-context-injection",
      event: {
        messages: [
          { role: "user", content: "review the screenshot" },
          {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/png", data: "SCREENSHOT_BASE64" }],
          },
        ],
      },
      sessionPathRef: { current: "/tmp/session.jsonl" },
      targetModelRef: { current: { id: "deepseek-chat", provider: "deepseek", input: ["text"] } },
      getVisionBridge: () => ({
        prepareResources: vi.fn(async () => {
          throw new Error("vision model unavailable");
        }),
        injectNotes: vi.fn(() => ({ injected: 0 })),
      }),
      isVisionAuxiliaryEnabled: () => true,
      warn,
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: VISION_CONTEXT_INJECTION_FAILED,
        path: "codia-test-vision-context-injection",
        sessionPath: "/tmp/session.jsonl",
        targetModel: { id: "deepseek-chat", provider: "deepseek" },
        message: "vision model unavailable",
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      code: VISION_CONTEXT_INJECTION_FAILED,
    }));
    expect(result.messages[0].content).toContain(VISION_CONTEXT_START);
    expect(result.messages[0].content).toContain(VISION_CONTEXT_INJECTION_FAILED);
  });
});
