/**
 * MiniMax Token Plan provider plugin (API key).
 *
 * Token Plan uses a subscription key that is not interchangeable with the
 * pay-as-you-go MiniMax API key, so keep it as a separate provider id.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const minimaxTokenPlanPlugin = {
  id: "minimax-token-plan",
  displayName: "MiniMax Token Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  defaultApi: "anthropic-messages",
};
