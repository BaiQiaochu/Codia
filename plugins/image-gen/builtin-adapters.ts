import { agnesImageAdapter, agnesVideoAdapter } from "./adapters/agnes.ts";
import { dashscopeImageAdapter } from "./adapters/dashscope.ts";
import { geminiImageAdapter } from "./adapters/gemini.ts";
import { minimaxImageAdapter } from "./adapters/minimax.ts";
import { openaiCodexImageAdapter } from "./adapters/openai-codex.ts";
import { openaiCompatibleMediaAdapter } from "./adapters/openai-compatible-media.ts";
import { openaiImageAdapter } from "./adapters/openai.ts";
import { volcengineImageAdapter } from "./adapters/volcengine.ts";
import { volcengineVideoAdapter } from "./adapters/volcengine-video.ts";

export const builtinImageGenAdapters = Object.freeze([
  volcengineImageAdapter,
  volcengineVideoAdapter,
  openaiImageAdapter,
  openaiCodexImageAdapter,
  minimaxImageAdapter,
  dashscopeImageAdapter,
  geminiImageAdapter,
  agnesImageAdapter,
  agnesVideoAdapter,
  openaiCompatibleMediaAdapter,
]);
