// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashscopeSpeechRecognitionAdapter,
  mimoSpeechRecognitionAdapter,
  openaiSpeechRecognitionAdapter,
  volcengineSpeechRecognitionAdapter,
} from "../core/speech-recognition/adapters.js";

let tmpDir;
let audioFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-speech-adapter-"));
  audioFile = path.join(tmpDir, "voice.wav");
  fs.writeFileSync(audioFile, "RIFF");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeInput(overrides = {}) {
  return {
    file: {
      filePath: audioFile,
      mime: "audio/wav",
      size: 4,
    },
    provider: {
      id: "provider",
      baseUrl: "https://example.test/v1",
    },
    model: {
      id: "model",
      protocolId: "protocol",
    },
    credentials: {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
    },
    language: "zh",
    ...overrides,
  };
}

describe("speech recognition adapters", () => {
  it("calls OpenAI audio transcriptions with multipart form data", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 }));

    const result = await openaiSpeechRecognitionAdapter.transcribe(makeInput({
      model: { id: "gpt-4o-mini-transcribe", protocolId: "openai-audio-transcriptions" },
      credentials: { apiKey: "openai-key", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
      fetch: fetchImpl,
    }));

    expect(result.text).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/audio/transcriptions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer openai-key" }),
      body: expect.any(FormData),
    }));
  });

  it("calls MiMo ASR through chat completions input_audio data URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hello" } }],
    }), { status: 200 }));

    const result = await mimoSpeechRecognitionAdapter.transcribe(makeInput({
      provider: { id: "mimo", baseUrl: "https://api.xiaomimimo.com/v1" },
      model: { id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" },
      credentials: { apiKey: "mimo-key", baseUrl: "https://api.xiaomimimo.com/v1", api: "openai-completions" },
      fetch: fetchImpl,
    }));

    expect(result.text).toBe("hello");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ "api-key": "mimo-key", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({
      model: "mimo-v2.5-asr",
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: { data: "data:audio/wav;base64,UklGRg==" },
        }],
      }],
      asr_options: { language: "zh" },
    });
  });

  it("calls MiMo Token Plan ASR through the Token Plan OpenAI-compatible base URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "token plan ready" } }],
    }), { status: 200 }));

    const result = await mimoSpeechRecognitionAdapter.transcribe(makeInput({
      provider: { id: "mimo-token-plan", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
      model: { id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" },
      credentials: { apiKey: "tp-mimo-key", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", api: "openai-completions" },
      fetch: fetchImpl,
    }));

    expect(result.text).toBe("token plan ready");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    expect(url).not.toContain("/anthropic");
    expect(init.headers).toMatchObject({ "api-key": "tp-mimo-key", "Content-Type": "application/json" });
  });

  it("calls DashScope Qwen ASR through the OpenAI-compatible input_audio shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "dashscope ready" } }],
    }), { status: 200 }));

    await dashscopeSpeechRecognitionAdapter.transcribe(makeInput({
      provider: { id: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      model: { id: "qwen3-asr-flash", protocolId: "dashscope-qwen-asr-chat" },
      credentials: { apiKey: "dashscope-key", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
      fetch: fetchImpl,
    }));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer dashscope-key", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({
      model: "qwen3-asr-flash",
      stream: false,
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: { data: "data:audio/wav;base64,UklGRg==" },
        }],
      }],
      asr_options: { language: "zh", enable_itn: false },
    });
  });

  it("calls Volcengine BigASR flash with resource headers and raw base64 audio data", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: { text: "volcengine ready" },
      audio_info: { duration: 2499 },
    }), {
      status: 200,
      headers: { "X-Api-Status-Code": "20000000" },
    }));

    const result = await volcengineSpeechRecognitionAdapter.transcribe(makeInput({
      provider: { id: "volcengine-speech", baseUrl: "https://openspeech.bytedance.com" },
      model: { id: "bigasr-flash", protocolId: "volcengine-bigasr-transcription" },
      credentials: { apiKey: "volc-key", baseUrl: "https://openspeech.bytedance.com", api: "volcengine-bigasr" },
      fetch: fetchImpl,
    }));

    expect(result).toMatchObject({ text: "volcengine ready", durationMs: 2499 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
    expect(init.headers).toMatchObject({
      "X-Api-Key": "volc-key",
      "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
      "X-Api-Sequence": "-1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toMatchObject({
      user: { uid: "volc-key" },
      audio: { data: "UklGRg==" },
      request: { model_name: "bigmodel" },
    });
  });
});
