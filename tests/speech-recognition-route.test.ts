import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSpeechRecognitionRoute } from "../server/routes/speech-recognition.js";

describe("speech recognition route", () => {
  it("returns runnable providers and persisted config from the speech service", async () => {
    const app = new Hono();
    const listProviders = vi.fn(() => ({
      providers: {
        mimo: {
          providerId: "mimo",
          displayName: "MiMo",
          hasCredentials: true,
          models: [{ id: "mimo-v2.5-asr", displayName: "MiMo ASR", protocolId: "mimo-chat-completions-asr" }],
        },
      },
      config: { enabled: true, defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" } },
    }));
    app.route("/api", createSpeechRecognitionRoute({
      speechRecognition: { listProviders },
    }));

    const res = await app.request("/api/speech-recognition/providers");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      providers: {
        mimo: {
          providerId: "mimo",
          displayName: "MiMo",
          hasCredentials: true,
          models: [{ id: "mimo-v2.5-asr", displayName: "MiMo ASR", protocolId: "mimo-chat-completions-asr" }],
        },
      },
      config: { enabled: true, defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" } },
    });
  });

  it("saves speech recognition config through the speech service", async () => {
    const app = new Hono();
    const setConfig = vi.fn(() => ({
      enabled: true,
      defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
    }));
    app.route("/api", createSpeechRecognitionRoute({
      speechRecognition: {
        listProviders: () => ({ providers: {}, config: {} }),
        setConfig,
      },
    }));

    const res = await app.request("/api/speech-recognition/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: {
          enabled: true,
          defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(setConfig).toHaveBeenCalledWith({
      enabled: true,
      defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
    });
    expect(await res.json()).toEqual({
      ok: true,
      config: { enabled: true, defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" } },
    });
  });
});
