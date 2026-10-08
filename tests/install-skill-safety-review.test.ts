import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/i18n.ts", () => ({
  getLocale: () => "en",
  t: (key: string, values?: Record<string, unknown>) => values?.reply ? `${key}:${values.reply}` : key,
}));

vi.mock("../core/llm-client.ts", () => ({
  callText: vi.fn(),
}));

import { callText } from "../core/llm-client.ts";
import { safetyReview } from "../lib/tools/install-skill.ts";

describe("install_skill safety review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not cap the utility review output with maxTokens", async () => {
    (callText as any).mockResolvedValueOnce("safe");

    const result = await safetyReview("---\nname: demo\n---\n# Demo\n", () => ({
      utility: "utility-model",
      api_key: "key",
      base_url: "https://example.test",
      api: "openai",
    }));

    expect(result).toEqual({ safe: true });
    expect(callText).toHaveBeenCalledOnce();
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });
});
