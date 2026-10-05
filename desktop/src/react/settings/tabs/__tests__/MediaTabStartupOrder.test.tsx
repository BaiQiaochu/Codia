/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../api', () => ({
  gsapFetch: (...args: unknown[]) => mocks.gsapFetch(...args),
}));

import { MediaTab } from '../MediaTab';
import { useSettingsStore } from '../../store';

describe('MediaTab settings startup order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      ready: false,
      currentAgentId: null,
      settingsAgentId: null,
      serverPort: null,
    });
    mocks.gsapFetch.mockResolvedValue({
      json: async () => ({
        providers: {},
        config: {},
      }),
    });
    vi.stubGlobal('window', Object.assign(window, {
      i18n: { locale: 'zh-CN' },
      speechSynthesis: {
        getVoices: vi.fn(() => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        cancel: vi.fn(),
        speak: vi.fn(),
      },
    }));
    URL.createObjectURL = vi.fn(() => 'blob:media-diagnostics');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('waits for settings readiness and an agent id before loading scoped media config', async () => {
    render(<MediaTab />);

    expect(mocks.gsapFetch).not.toHaveBeenCalled();

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/plugins/image-gen/providers?agentId=gsap');
    });
    expect(screen.getByTestId('media-defaultImageModel')).toBeTruthy();
  });

  it('shows only actual scanned models in global defaults and clears stale saved defaults', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/config')) {
        return { json: async () => ({ ok: true }) };
      }
      return {
        json: async () => ({
          providers: {
            openai: {
              providerId: 'openai',
              hasCredentials: true,
              models: [],
              availableImageModels: [{ id: 'gpt-image-1', name: 'GPT Image 1', type: 'image' }],
            },
            image2: {
              providerId: 'image2',
              hasCredentials: true,
              imageModels: [{ id: 'gptimage2', name: 'gptimage2', type: 'image' }],
              availableImageModels: [{ id: 'dall-e-3', name: 'DALL-E 3', type: 'image' }],
            },
          },
          config: {
            defaultImageModel: { provider: 'openai', id: 'legacy-image' },
          },
        }),
      };
    });

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });
    render(<MediaTab />);

    const select = await screen.findByTestId('media-defaultImageModel') as HTMLSelectElement;
    await waitFor(() => {
      const optionTexts = [...select.options].map(option => option.textContent || '');
      expect(optionTexts).toContain('image2 / gptimage2');
      expect(optionTexts).not.toContain('openai / GPT Image 1');
      expect(optionTexts).not.toContain('image2 / DALL-E 3');
    });

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/plugins/image-gen/config?agentId=gsap', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ values: { defaultImageModel: null } }),
      }));
    });
  });

  it('clears the saved default image model when it is only available as a provider candidate', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/config')) {
        return { json: async () => ({ ok: true }) };
      }
      return {
        json: async () => ({
          providers: {
            image2: {
              providerId: 'image2',
              hasCredentials: true,
              models: [],
              availableImageModels: [{ id: 'gptimage2', name: 'GPT Image 2', type: 'image' }],
            },
          },
          config: {
            defaultImageModel: { provider: 'image2', id: 'gptimage2' },
          },
        }),
      };
    });

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });
    render(<MediaTab />);

    const select = await screen.findByTestId('media-defaultImageModel') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(''));
    expect([...select.options].map(option => option.textContent || '')).not.toContain('image2 / GPT Image 2');
    expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/plugins/image-gen/config?agentId=gsap', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ values: { defaultImageModel: null } }),
    }));
  });

  it('does not show provider candidate models as imported default model choices', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/config')) {
        return { json: async () => ({ ok: true }) };
      }
      return {
        json: async () => ({
          providers: {
            image2: {
              providerId: 'image2',
              displayName: 'Image Provider',
              hasCredentials: true,
              imageModels: [{ id: 'imported-image', name: 'Imported Image', type: 'image' }],
              availableImageModels: [{ id: 'preset-candidate', name: 'Preset Candidate', type: 'image' }],
              models: [],
              availableModels: [],
            },
          },
          config: {},
        }),
      };
    });

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });
    render(<MediaTab />);

    const select = await screen.findByTestId('media-defaultImageModel') as HTMLSelectElement;
    const optionText = Array.from(select.options).map(option => option.textContent || '').join('\n');
    expect(optionText).toContain('image2 / Imported Image');
    expect(optionText).not.toContain('Preset Candidate');
    expect(screen.getAllByText('Image Provider').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Preset Candidate')).toBeFalsy();
  });

  it('clears stale built-in fallback audio and video defaults instead of keeping them selected', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/config')) {
        return { json: async () => ({ ok: true }) };
      }
      return {
        json: async () => ({
          providers: {},
          config: {
            defaultAudioModel: { provider: 'minimax', id: 'speech-2.8-hd' },
            defaultVideoModel: { provider: 'volcengine', id: 'doubao-seedance-2-0-260128' },
          },
        }),
      };
    });

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });
    render(<MediaTab />);

    const audioSelect = await screen.findByTestId('media-defaultAudioModel') as HTMLSelectElement;
    const videoSelect = await screen.findByTestId('media-defaultVideoModel') as HTMLSelectElement;

    await waitFor(() => {
      expect(audioSelect.value).toBe('');
      expect(videoSelect.value).toBe('');
    });

    await waitFor(() => {
      expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/plugins/image-gen/config?agentId=gsap', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          values: {
            defaultAudioModel: null,
            defaultVideoModel: null,
          },
        }),
      }));
    });
  });

  it('switches between image, speech, music, and video modules while preserving global defaults', async () => {
    mocks.gsapFetch.mockResolvedValue({
      json: async () => ({
        providers: {
          volcengine: {
            providerId: 'volcengine',
            displayName: 'Volcengine',
            hasCredentials: true,
            imageModels: [{ id: 'seedream', name: 'Seedream', type: 'image' }],
            audioModels: [{ id: 'voice-default', name: 'Voice Default', type: 'audio' }],
            musicModels: [{ id: 'music-default', name: 'Music Default', type: 'music' }],
            videoModels: [{ id: 'video-default', name: 'Video Default', type: 'video' }],
            availableImageModels: [],
            availableAudioModels: [],
            availableMusicModels: [],
            availableVideoModels: [],
          },
        },
        config: {
          defaultImageModel: { provider: 'volcengine', id: 'seedream' },
          defaultAudioModel: { provider: 'volcengine', id: 'voice-default' },
          defaultMusicModel: { provider: 'volcengine', id: 'music-default' },
          defaultVideoModel: { provider: 'volcengine', id: 'video-default' },
        },
      }),
    });

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });
    render(<MediaTab />);

    expect(await screen.findByText('settings.media.imageGeneration')).toBeTruthy();
    expect(screen.getByTestId('media-module-image')).toBeTruthy();
    expect(screen.getByTestId('media-module-audio')).toBeTruthy();
    expect(screen.getByTestId('media-module-music')).toBeTruthy();
    expect(screen.getByTestId('media-module-video')).toBeTruthy();

    expect(await screen.findByTestId('media-defaultImageModel')).toBeTruthy();
    expect(screen.getByTestId('media-defaultAudioModel')).toBeTruthy();
    expect(screen.getByTestId('media-defaultMusicModel')).toBeTruthy();
    expect(screen.getByTestId('media-defaultVideoModel')).toBeTruthy();
    expect(screen.getByTestId('media-defaults-grid')).toBeTruthy();
    expect(screen.getAllByTestId(/^media-default-field-/)).toHaveLength(4);

    fireEvent.click(screen.getByTestId('media-module-audio'));
    expect(screen.getAllByText('settings.media.audioModels').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId('media-module-music'));
    expect(screen.getAllByText('settings.media.musicModels').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId('media-module-video'));
    expect(screen.getAllByText('settings.media.videoModels').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('media-diagnostics')).toBeTruthy();
    expect(screen.getByTestId('media-diagnostics-audio').textContent).toContain('voice-default');
    fireEvent.click(screen.getByTestId('media-diagnostics-export'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('voice-input-device')).toBeTruthy();
    expect(screen.getByTestId('voice-synthesis-voice')).toBeTruthy();
  });

  it('does not use speech provider candidate models as default transcription choices', async () => {
    mocks.gsapFetch.mockImplementation(async (url: string) => {
      if (url === '/api/speech-recognition/providers') {
        return {
          json: async () => ({
            providers: {
              speechy: {
                providerId: 'speechy',
                displayName: 'Speechy',
                hasCredentials: true,
                models: [],
                availableModels: [{ id: 'candidate-stt', name: 'Candidate STT' }],
              },
            },
            config: { enabled: true },
          }),
        };
      }
      return {
        json: async () => ({
          providers: {},
          config: {},
        }),
      };
    });

    useSettingsStore.setState({ ready: true, currentAgentId: 'gsap', serverPort: 52022 });
    render(<MediaTab />);

    const select = await screen.findByTestId('speech-recognition-default-model') as HTMLSelectElement;
    const optionTexts = [...select.options].map(option => option.textContent || '');
    expect(optionTexts).not.toContain('speechy / Candidate STT');
    expect(select.disabled).toBe(true);
  });
});
