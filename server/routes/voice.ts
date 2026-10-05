// @ts-nocheck
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { createScopedConfigAccessor } from "../../plugins/image-gen/lib/scoped-config.ts";

const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
const OPENAI_COMPATIBLE_APIS = new Set(["openai", "openai-completions", "openai-responses"]);

function cleanString(value) {
  return String(value || "").trim();
}

function trimTrailingSlash(value) {
  return cleanString(value).replace(/\/+$/, "");
}

function pickUploadedAudio(body) {
  for (const value of Object.values(body || {})) {
    if (value && typeof value.arrayBuffer === "function") return value;
  }
  return null;
}

function buildOpenAiAudioTranscriptionsUrl(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  if (!base) return "";
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  if (/\/v\d+\/(?:chat\/completions|completions|responses|models)$/i.test(base)) {
    return base.replace(/\/(?:chat\/completions|completions|responses|models)$/i, "/audio/transcriptions");
  }
  if (/\/v\d+$/i.test(base)) return `${base}/audio/transcriptions`;
  return `${base}/v1/audio/transcriptions`;
}

function resolveImageGenConfig(engine, agentId) {
  const plugin = engine?.pluginManager?.getPlugin?.("image-gen");
  const ctx = plugin?.ctx;
  if (!ctx?.dataDir) return null;
  return createScopedConfigAccessor(ctx, agentId || null);
}

function resolveDefaultAudioModel(engine, agentId) {
  const config = resolveImageGenConfig(engine, agentId);
  const configured = config?.get?.("defaultAudioModel");
  if (configured?.provider && configured?.id) {
    return {
      provider: cleanString(configured.provider),
      model: cleanString(configured.id),
    };
  }
  return null;
}

function resolveTranscriptionConfig(engine, agentId) {
  const selected = resolveDefaultAudioModel(engine, agentId);
  if (!selected?.provider || !selected?.model) {
    return {
      ok: false,
      status: 501,
      error: "speech-to-text model is not configured",
    };
  }

  const creds = engine?.resolveProviderCredentials?.(selected.provider) || {};
  const api = cleanString(creds.api);
  const apiKey = cleanString(creds.api_key);
  const baseUrl = cleanString(creds.base_url);
  if (!OPENAI_COMPATIBLE_APIS.has(api)) {
    return {
      ok: false,
      status: 501,
      error: `speech-to-text provider "${selected.provider}" is not OpenAI-compatible`,
    };
  }
  if (!baseUrl) {
    return {
      ok: false,
      status: 501,
      error: `speech-to-text provider "${selected.provider}" is missing base_url`,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      status: 501,
      error: `speech-to-text provider "${selected.provider}" is missing api_key`,
    };
  }

  return {
    ok: true,
    provider: selected.provider,
    model: selected.model,
    apiKey,
    endpoint: buildOpenAiAudioTranscriptionsUrl(baseUrl),
  };
}

async function readProviderError(res) {
  try {
    const text = await res.text();
    return text.trim().slice(0, 500) || res.statusText || "transcription provider failed";
  } catch {
    return res.statusText || "transcription provider failed";
  }
}

async function transcribeWithSpeechRecognitionService(engine, audio, language) {
  const service = engine?.speechRecognition;
  if (!service || typeof service.getConfig !== "function" || typeof service.transcribeFile !== "function") return null;
  const config = service.getConfig();
  if (config?.enabled !== true || !config.defaultModel) return null;

  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.length === 0) throw new Error("empty audio file");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gsap-voice-"));
  const ext = path.extname(audio.name || "") || ".audio";
  const tempPath = path.join(tempDir, `${randomUUID()}${ext}`);
  try {
    await fs.writeFile(tempPath, bytes);
    const result = await service.transcribeFile({
      file: {
        filePath: tempPath,
        realPath: tempPath,
        displayName: audio.name || path.basename(tempPath),
        filename: audio.name || path.basename(tempPath),
        mime: audio.type || "audio/webm",
      },
      language,
    });
    const text = cleanString(result?.text);
    if (!text) throw new Error("no speech recognized");
    return { text, transcription: result };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createVoiceRoute(engine) {
  const route = new Hono();

  route.post("/voice/transcribe", bodyLimit({ maxSize: MAX_AUDIO_UPLOAD_BYTES }), async (c) => {
    const body = await c.req.parseBody();
    const audio = pickUploadedAudio(body);
    if (!audio) {
      return c.json({ error: "audio file is required" }, 400);
    }

    const agentId = cleanString(body.agentId || c.req.query("agentId"));
    const lang = cleanString(body.lang || body.language);

    try {
      const serviceResult = await transcribeWithSpeechRecognitionService(engine, audio, lang || undefined);
      if (serviceResult) return c.json(serviceResult);
    } catch (err) {
      return c.json({ error: err?.message || "transcription request failed" }, 502);
    }

    const config = resolveTranscriptionConfig(engine, agentId);
    if (!config.ok) {
      return c.json({ error: config.error }, config.status);
    }

    const bytes = await audio.arrayBuffer();
    const providerBody = new FormData();
    providerBody.append("model", config.model);
    providerBody.append("file", new Blob([bytes], { type: audio.type || "audio/webm" }), audio.name || "voice.webm");
    if (lang) providerBody.append("language", lang);
    providerBody.append("response_format", "json");

    let res;
    try {
      res = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: providerBody,
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      return c.json({ error: err?.message || "transcription request failed" }, 502);
    }

    if (!res.ok) {
      return c.json({ error: await readProviderError(res) }, 502);
    }

    const data = await res.json().catch(() => ({}));
    const text = cleanString(data.text || data.transcript || data.result);
    if (!text) {
      return c.json({ error: "no speech recognized" }, 422);
    }
    return c.json({ text });
  });

  return route;
}
