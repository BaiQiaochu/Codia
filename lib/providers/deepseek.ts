/**
 * DeepSeek provider plugin
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const deepseekPlugin = {
  id: "deepseek",
  displayName: "DeepSeek",
  authType: "api-key",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  defaultApi: "openai-completions",
};
