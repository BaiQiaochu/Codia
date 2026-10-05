import { describe, expect, it } from 'vitest';
import {
  collectActualDefaultModels,
  sanitizeDefaultMediaConfig,
  type MediaProviderSummary,
} from '../../settings/tabs/media/media-default-models';

describe('media default model helpers', () => {
  it('only exposes imported actual media models for global defaults', () => {
    const providers: Record<string, MediaProviderSummary> = {
      imported: {
        models: [
          { id: 'legacy-image-candidate', name: 'Legacy Image Candidate', type: 'image' },
        ],
        imageModels: [{ id: 'actual-image', name: 'Actual Image', type: 'image' }],
        videoModels: [{ id: 'actual-video', name: 'Actual Video', type: 'video' }],
        availableImageModels: [{ id: 'preset-image', name: 'Preset Image', type: 'image' }],
        availableVideoModels: [{ id: 'preset-video', name: 'Preset Video', type: 'video' }],
      },
      candidatesOnly: {
        models: [{ id: 'candidate-from-models', name: 'Candidate From Models', type: 'image' }],
        availableImageModels: [{ id: 'candidate-image', name: 'Candidate Image', type: 'image' }],
        availableVideoModels: [{ id: 'candidate-video', name: 'Candidate Video', type: 'video' }],
      },
    };

    expect(collectActualDefaultModels(providers, 'image').map(model => `${model.provider}/${model.id}`))
      .toEqual(['imported/actual-image']);
    expect(collectActualDefaultModels(providers, 'video').map(model => `${model.provider}/${model.id}`))
      .toEqual(['imported/actual-video']);
  });

  it('clears stale defaults that point to non-imported media models', () => {
    const providers: Record<string, MediaProviderSummary> = {
      imported: {
        imageModels: [{ id: 'actual-image', name: 'Actual Image', type: 'image' }],
      },
    };

    const result = sanitizeDefaultMediaConfig({
      defaultImageModel: { provider: 'imported', id: 'preset-image' },
      defaultVideoModel: { provider: 'missing', id: 'preset-video' },
    }, providers);

    expect(result.config.defaultImageModel).toBeNull();
    expect(result.config.defaultVideoModel).toBeNull();
    expect(result.updates).toEqual({
      defaultImageModel: null,
      defaultVideoModel: null,
    });
  });
});
