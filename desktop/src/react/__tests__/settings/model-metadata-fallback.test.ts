// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { lookupModelMeta } from '../../settings/helpers';

describe('settings model metadata fallback', () => {
  it('uses known-model-fallbacks when a model is absent from provider dictionaries', () => {
    expect(lookupModelMeta('qwen3.6-27b')).toMatchObject({
      name: 'Qwen 3.6 27B',
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      _source: 'reference',
    });
  });
});
