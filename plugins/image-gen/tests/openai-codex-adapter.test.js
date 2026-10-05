import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCodexImageAdapter } from "../adapters/openai-codex.js";

const IMAGE_RESULT = Buffer.from("codex-image").toString("base64");

function makeToken(accountId = "acct_test") {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function createCtx(tmpDir, overrides = {}) {
  return {
    dataDir: tmpDir,
    config: {
      get: (key) => {
        if (key === "providerDefaults") return overrides.providerDefaults || {};
        return {};
      },
    },
    bus: {
      request: vi.fn(async (type, payload) => {
        if (type === "provider:credentials" && payload.providerId === "openai-codex-oauth") {
          return {
            apiKey: makeToken(overrides.accountId || "acct_test"),
            baseUrl: overrides.baseUrl || "https://chatgpt.test/backend-api",
            ...(overrides.accountId ? { accountId: overrides.accountId } : {}),
          };
        }
        return { error: "not_found" };
      }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openaiCodexImageAdapter", () => {
  it("submits image generation through ChatGPT codex responses and saves returned images", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-codex-image-"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: "image_generation_call", result: IMAGE_RESULT }],
      }),
    });

    const result = await openaiCodexImageAdapter.submit({
      prompt: "city skyline",
      ratio: "16:9",
      format: "png",
    }, createCtx(tmpDir, {
      providerDefaults: {
        "openai-codex-oauth": { responsesModel: "gpt-5.5" },
      },
    }));

    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "generated", result.files[0]))).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.test/backend-api/codex/responses");
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(init.headers["chatgpt-account-id"]).toBe("acct_test");
    expect(init.headers["OpenAI-Beta"]).toBe("responses=experimental");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "gpt-5.5",
      store: false,
      stream: true,
      tools: [{ type: "image_generation", output_format: "png", size: "1536x1024" }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "city skyline" });
  });

  it("preserves ordered images param as input_image content", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-codex-image-refs-"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: "image_generation_call", result: IMAGE_RESULT }],
      }),
    });

    await openaiCodexImageAdapter.submit({
      prompt: "combine refs",
      images: [
        "https://cdn.example.test/pose.png",
        "https://cdn.example.test/style.png",
      ],
    }, createCtx(tmpDir));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "combine refs" },
      { type: "input_image", image_url: "https://cdn.example.test/pose.png" },
      { type: "input_image", image_url: "https://cdn.example.test/style.png" },
    ]);
  });

  it("does not default Codex image requests to GPT-5.5 when responsesModel is unset", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-codex-image-default-model-"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: "image_generation_call", result: IMAGE_RESULT }],
      }),
    });

    await openaiCodexImageAdapter.submit({
      prompt: "default model",
    }, createCtx(tmpDir));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4.1");
  });

  it("reports missing OAuth credentials from checkAuth", async () => {
    const result = await openaiCodexImageAdapter.checkAuth({
      bus: { request: vi.fn(async () => ({ error: "missing" })) },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("openai-codex-oauth");
  });
});
