/**
 * SGLang provider plugin.
 *
 * SGLang exposes an OpenAI-compatible API, usually at http://127.0.0.1:30000/v1.
 * API key is optional unless the SGLang server was started with authentication.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const sglangPlugin = {
  id: "sglang",
  displayName: "SGLang",
  authType: "none",
  defaultBaseUrl: "http://127.0.0.1:30000/v1",
  defaultApi: "openai-completions",
};
