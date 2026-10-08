// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_NO_PAPER_TEXTURE_CLASS,
  PAPER_TEXTURE_STORAGE_KEY,
  applyPaperTextureClass,
  isPaperTextureEnabled,
  loadPaperTexturePreference,
  setPaperTexturePreference,
} from '../../../shared/appearance-preferences';
import registry from '../../../shared/theme-registry';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('legacy paper texture compatibility preferences', () => {
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    storage = createStorage();
    document.body.className = '';
    document.body.dataset.paperTexture = '';
  });

  it('defaults to disabled with the legacy no-texture class applied', () => {
    const enabled = loadPaperTexturePreference(storage, document.body, registry.AUTO_LIGHT_DEFAULT);

    expect(enabled).toBe(false);
    expect(document.body.classList.contains(LEGACY_NO_PAPER_TEXTURE_CLASS)).toBe(true);
    expect(document.body.dataset.paperTexture).toBe('off');
  });

  it('retains an explicit preference without enabling the retired effect', () => {
    storage.setItem(PAPER_TEXTURE_STORAGE_KEY, '1');

    expect(isPaperTextureEnabled(storage)).toBe(true);
    expect(loadPaperTexturePreference(storage, document.body, registry.AUTO_LIGHT_DEFAULT)).toBe(true);
    expect(document.body.classList.contains(LEGACY_NO_PAPER_TEXTURE_CLASS)).toBe(true);
    expect(document.body.dataset.paperTexture).toBe('off');
  });

  it('persists off as an explicit disabled state', () => {
    setPaperTexturePreference(true, storage, document.body, registry.AUTO_LIGHT_DEFAULT);
    setPaperTexturePreference(false, storage, document.body, registry.AUTO_LIGHT_DEFAULT);

    expect(storage.getItem(PAPER_TEXTURE_STORAGE_KEY)).toBe('0');
    expect(document.body.classList.contains(LEGACY_NO_PAPER_TEXTURE_CLASS)).toBe(true);
    expect(document.body.dataset.paperTexture).toBe('off');
  });

  it('keeps the stored preference but suppresses texture in blocked themes', () => {
    setPaperTexturePreference(true, storage, document.body, registry.AUTO_DARK_DEFAULT);

    expect(storage.getItem(PAPER_TEXTURE_STORAGE_KEY)).toBe('1');
    expect(isPaperTextureEnabled(storage)).toBe(true);
    expect(document.body.classList.contains(LEGACY_NO_PAPER_TEXTURE_CLASS)).toBe(true);
    expect(document.body.dataset.paperTexture).toBe('off');
  });

  it('keeps the retired effect suppressed across theme changes', () => {
    storage.setItem(PAPER_TEXTURE_STORAGE_KEY, '1');

    expect(loadPaperTexturePreference(storage, document.body, registry.LEGACY_THEME_ALIASES['terminal-soft'])).toBe(true);
    expect(document.body.dataset.paperTexture).toBe('off');

    expect(loadPaperTexturePreference(storage, document.body, registry.AUTO_LIGHT_DEFAULT)).toBe(true);
    expect(document.body.classList.contains(LEGACY_NO_PAPER_TEXTURE_CLASS)).toBe(true);
    expect(document.body.dataset.paperTexture).toBe('off');
  });

  it('applies current theme suppression without changing storage', () => {
    expect(applyPaperTextureClass(true, document.body, registry.AUTO_DARK_DEFAULT)).toBe(false);
    expect(document.body.dataset.paperTexture).toBe('off');
  });
});
