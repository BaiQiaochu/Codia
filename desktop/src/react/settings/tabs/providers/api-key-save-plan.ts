import { isRuntimeApiKeyRef } from '../../../../../../shared/runtime-api-key-ref.ts';

export interface ApiKeySavePlanInput {
  keyEdited: boolean;
  keyVal: string;
  urlEdited: boolean;
  urlVal: string;
  derivedBaseUrl: string;
  isPresetSetup: boolean;
  isLocalPreset: boolean;
  seedDefaultModels?: boolean;
  api: string;
}

export interface ApiKeySavePlan {
  shouldSave: boolean;
  shouldVerify: boolean;
  payload: Record<string, unknown>;
  effectiveUrl: string;
  api: string;
  key: string;
}

const VIDEO_GENERATION_SUFFIX = /\/videos\/generations\/?$/i;

function normalizeProviderBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(VIDEO_GENERATION_SUFFIX, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(VIDEO_GENERATION_SUFFIX, '').replace(/\/+$/, '');
  }
}

export function getApiKeySavePlan(input: ApiKeySavePlanInput): ApiKeySavePlan {
  const rawKey = input.keyVal.trim();
  const key = isRuntimeApiKeyRef(rawKey) ? '' : rawKey;
  const effectiveUrl = normalizeProviderBaseUrl(input.urlVal.trim() || input.derivedBaseUrl);

  if (!input.keyEdited || isRuntimeApiKeyRef(rawKey)) {
    return {
      shouldSave: false,
      shouldVerify: false,
      payload: {},
      effectiveUrl,
      api: input.api,
      key,
    };
  }

  const payload: Record<string, unknown> = input.isPresetSetup
    ? {
        base_url: effectiveUrl,
        api_key: key,
        api: input.api,
        seed_default_models: true,
        ...(input.isLocalPreset ? { auth_type: 'none' } : {}),
      }
    : { api_key: key };

  if (input.seedDefaultModels) {
    payload.seed_default_models = true;
  }

  if (input.urlEdited && !input.isPresetSetup) {
    payload.base_url = effectiveUrl;
  }

  return {
    shouldSave: true,
    shouldVerify: key !== "" || input.isLocalPreset,
    payload,
    effectiveUrl,
    api: input.api,
    key,
  };
}
