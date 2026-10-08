/**
 * Zhipu GLM Coding Plan provider plugin.
 *
 * Z.AI DevPack Coding Plan exposes a fixed model set through an
 * OpenAI Chat Completions-compatible endpoint. It is the same vendor as
 * zhipu, but a separate subscription/runtime lane from the public BigModel API.
 *
 * Docs: https://docs.z.ai/devpack/tool/others
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const zhipuCodingPlugin = {
  id: "zhipu-coding",
  displayName: "Zhipu GLM Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
  defaultApi: "openai-completions",
};
