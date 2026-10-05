import { describe, expect, it } from 'vitest';
import {
  collectActualDefaultModels,
  sanitizeDefaultMediaConfig,
  type MediaProviderSummary,
} from './media-default-models';

describe('media default model source', () => {
  it('uses actual scanned models and excludes built-in available candidates', () => {
    const providers: Record<string, MediaProviderSummary> = {
      openai: {
        providerId: 'openai',
        models: [],
        availableImageModels: [{ id: 'gpt-image-1', name: 'GPT Image 1', type: 'image' }],
      },
      image2: {
        providerId: 'image2',
        imageModels: [{ id: 'gptimage2', name: 'gptimage2', type: 'image' }],
        availableImageModels: [{ id: 'dall-e-3', name: 'DALL-E 3', type: 'image' }],
      },
    };

    expect(collectActualDefaultModels(providers, 'image')).toEqual([
      { provider: 'image2', id: 'gptimage2', name: 'gptimage2', type: 'image' },
    ]);
  });

  it('does not treat legacy provider models as imported image models', () => {
    const providers: Record<string, MediaProviderSummary> = {
      mixed: {
        providerId: 'mixed',
        models: [
          { id: 'qwen3.5', name: 'Qwen 3.5' },
          { id: 'gpt-image-2', name: 'GPT Image 2', type: 'image' },
        ],
        imageModels: [{ id: 'actual-image', name: 'Actual Image', type: 'image' }],
        availableModels: [
          { id: 'preset-chat', name: 'Preset Chat' },
          { id: 'preset-image', name: 'Preset Image', type: 'image' },
        ],
      },
    };

    expect(collectActualDefaultModels(providers, 'image')).toEqual([
      { provider: 'mixed', id: 'actual-image', name: 'Actual Image', type: 'image' },
    ]);
  });

  it('clears saved defaults that are only present as provider candidates', () => {
    const providers: Record<string, MediaProviderSummary> = {
      image2: {
        providerId: 'image2',
        hasCredentials: true,
        models: [],
        availableImageModels: [{ id: 'gptimage2', name: 'GPT Image 2', type: 'image' }],
      },
    };

    const result = sanitizeDefaultMediaConfig({
      defaultImageModel: { provider: 'image2', id: 'gptimage2' },
    }, providers);

    expect(result.config.defaultImageModel).toBeNull();
    expect(result.updates).toEqual({ defaultImageModel: null });
  });

  it('clears saved audio and video defaults that only exist as built-in fallback candidates', () => {
    const providers: Record<string, MediaProviderSummary> = {
      minimax: {
        providerId: 'minimax',
        hasCredentials: false,
        audioModels: [],
        availableAudioModels: [{ id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD', type: 'audio' }],
      },
      volcengine: {
        providerId: 'volcengine',
        hasCredentials: false,
        videoModels: [],
        availableVideoModels: [{ id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0', type: 'video' }],
      },
    };

    const result = sanitizeDefaultMediaConfig({
      defaultAudioModel: { provider: 'minimax', id: 'speech-2.8-hd' },
      defaultVideoModel: { provider: 'volcengine', id: 'doubao-seedance-2-0-260128' },
    }, providers);

    expect(result.config.defaultAudioModel).toBeNull();
    expect(result.config.defaultVideoModel).toBeNull();
    expect(result.updates).toEqual({
      defaultAudioModel: null,
      defaultVideoModel: null,
    });
  });

  it('clears saved defaults that are not present in actual scanned models', () => {
    const providers: Record<string, MediaProviderSummary> = {
      image2: {
        providerId: 'image2',
        models: [{ id: 'gptimage2', name: 'gptimage2', type: 'image' }],
      },
      tts: {
        providerId: 'tts',
        audioModels: [{ id: 'voice-plus', name: 'Voice Plus', type: 'audio' }],
      },
    };

    const result = sanitizeDefaultMediaConfig({
      defaultImageModel: { provider: 'openai', id: 'gpt-image-1' },
      defaultAudioModel: { provider: 'tts', id: 'voice-plus' },
      defaultMusicModel: { provider: 'minimax', id: 'music-2.6' },
      defaultVideoModel: null,
    }, providers);

    expect(result.config).toMatchObject({
      defaultImageModel: null,
      defaultAudioModel: { provider: 'tts', id: 'voice-plus' },
      defaultMusicModel: null,
      defaultVideoModel: null,
    });
    expect(result.updates).toEqual({
      defaultImageModel: null,
      defaultMusicModel: null,
    });
  });
});
