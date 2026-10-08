import type { ImageGenConfigPayload } from '../../shared-types';

export type MediaType = 'image' | 'audio' | 'music' | 'video';

export interface MediaModelSummary {
  id: string;
  name: string;
  type?: string;
}

export interface MediaModelWithProvider extends MediaModelSummary {
  provider: string;
}

export interface MediaProviderSummary {
  providerId?: string;
  hasCredentials?: boolean;
  models?: MediaModelSummary[];
  imageModels?: MediaModelSummary[];
  audioModels?: MediaModelSummary[];
  musicModels?: MediaModelSummary[];
  videoModels?: MediaModelSummary[];
  availableModels?: MediaModelSummary[];
  availableImageModels?: MediaModelSummary[];
  availableAudioModels?: MediaModelSummary[];
  availableMusicModels?: MediaModelSummary[];
  availableVideoModels?: MediaModelSummary[];
}

type DefaultModelKey = 'defaultImageModel' | 'defaultAudioModel' | 'defaultMusicModel' | 'defaultVideoModel';
type DefaultModelValue = { id: string; provider: string } | null | undefined;

const DEFAULT_ENTRIES: { type: MediaType; configKey: DefaultModelKey }[] = [
  { type: 'image', configKey: 'defaultImageModel' },
  { type: 'audio', configKey: 'defaultAudioModel' },
  { type: 'music', configKey: 'defaultMusicModel' },
  { type: 'video', configKey: 'defaultVideoModel' },
];

function actualModelsForType(provider: MediaProviderSummary, type: MediaType): MediaModelSummary[] {
  if (type === 'audio') return provider.audioModels || [];
  if (type === 'music') return provider.musicModels || [];
  if (type === 'video') return provider.videoModels || [];
  return provider.imageModels || [];
}

export function collectActualDefaultModels(
  providers: Record<string, MediaProviderSummary>,
  type: MediaType,
): MediaModelWithProvider[] {
  const result: MediaModelWithProvider[] = [];
  const seen = new Set<string>();

  for (const [providerId, provider] of Object.entries(providers || {})) {
    for (const model of actualModelsForType(provider, type)) {
      if (!model?.id) continue;
      const key = `${type}:${providerId}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...model, provider: providerId });
    }
  }

  return result;
}

function hasDefaultModel(
  providers: Record<string, MediaProviderSummary>,
  type: MediaType,
  providerId: string,
  modelId: string,
) {
  const provider = providers?.[providerId];
  if (!provider) return false;
  return actualModelsForType(provider, type).some((model) => model?.id === modelId);
}

export function sanitizeDefaultMediaConfig(
  config: ImageGenConfigPayload,
  providers: Record<string, MediaProviderSummary>,
): { config: ImageGenConfigPayload; updates: Partial<ImageGenConfigPayload> } {
  const next: ImageGenConfigPayload = { ...(config || {}) };
  const updates: Partial<ImageGenConfigPayload> = {};

  for (const { type, configKey } of DEFAULT_ENTRIES) {
    const defaultModel = next[configKey] as DefaultModelValue;
    if (!defaultModel || typeof defaultModel !== 'object') continue;
    if (hasDefaultModel(providers, type, defaultModel.provider, defaultModel.id)) continue;
    next[configKey] = null;
    updates[configKey] = null;
  }

  return { config: next, updates };
}
