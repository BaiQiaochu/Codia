// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../store', () => ({
  useSettingsStore: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../api', () => ({
  codiaFetch: vi.fn(),
}));

vi.mock('../../../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

import { MediaProviderDetail } from '../MediaProviderDetail';
import { codiaFetch } from '../../../api';

describe('MediaProviderDetail', () => {
  beforeEach(() => {
    (window as typeof window & { t?: (key: string) => string }).t = (key) => key;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows candidate-only media models without treating them as imported models', () => {
    const { container } = render(
      <MediaProviderDetail
        providerId="comfyui"
        provider={{
          displayName: 'ComfyUI',
          hasCredentials: true,
          baseUrl: 'http://127.0.0.1:8188',
          api: 'comfyui',
          isLocalOpenAICompatible: false,
          models: [],
          availableModels: [{ id: 'workflow', name: 'Workflow', type: 'image' }],
          imageModels: [],
          audioModels: [],
          musicModels: [],
          videoModels: [],
          availableImageModels: [{ id: 'workflow', name: 'Workflow', type: 'image' }],
          availableAudioModels: [],
          availableMusicModels: [],
          availableVideoModels: [],
        }}
        config={{ providerDefaults: {} }}
        onSaveConfig={vi.fn(async () => undefined)}
        onRefresh={vi.fn(async () => undefined)}
      />,
    );

    const defaultsGrid = container.querySelector('[class*="media-provider-defaults-grid"]');
    expect(defaultsGrid).toBeNull();

    const defaultsFields = container.querySelectorAll('[class*="media-provider-default-field"]');
    expect(defaultsFields).toHaveLength(0);
    expect(screen.getByText('0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /settings\.media\.addImageModel/ }));
    expect(screen.getByRole('button', { name: /Workflow/ })).toBeTruthy();
  });

  it('uses responsive classes for provider default controls in the narrow detail pane once a model is imported', () => {
    const { container } = render(
      <MediaProviderDetail
        providerId="comfyui"
        provider={{
          displayName: 'ComfyUI',
          hasCredentials: true,
          baseUrl: 'http://127.0.0.1:8188',
          api: 'comfyui',
          isLocalOpenAICompatible: false,
          models: [],
          availableModels: [],
          imageModels: [{ id: 'workflow', name: 'Workflow', type: 'image' }],
          audioModels: [],
          musicModels: [],
          videoModels: [],
          availableImageModels: [],
          availableAudioModels: [],
          availableMusicModels: [],
          availableVideoModels: [],
        }}
        config={{ providerDefaults: {} }}
        onSaveConfig={vi.fn(async () => undefined)}
        onRefresh={vi.fn(async () => undefined)}
      />,
    );

    const defaultsGrid = container.querySelector('[class*="media-provider-defaults-grid"]');
    expect(defaultsGrid).toBeTruthy();

    const defaultsFields = container.querySelectorAll('[class*="media-provider-default-field"]');
    expect(defaultsFields.length).toBeGreaterThan(0);

    for (const field of defaultsFields) {
      expect(field.querySelector('select, input')).toBeTruthy();
    }
  });

  it('shows video model controls and provider defaults when the video module is active', () => {
    render(
      <MediaProviderDetail
        providerId="volcengine"
        mediaType="video"
        provider={{
          displayName: 'Volcengine',
          hasCredentials: true,
          api: 'volcengine',
          isLocalOpenAICompatible: false,
          models: [],
          availableModels: [],
          imageModels: [],
          audioModels: [],
          musicModels: [],
          videoModels: [{ id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0', type: 'video' }],
          availableImageModels: [],
          availableAudioModels: [],
          availableMusicModels: [],
          availableVideoModels: [],
        }}
        config={{ providerDefaults: {} }}
        onSaveConfig={vi.fn(async () => undefined)}
        onRefresh={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText('settings.media.videoModels')).toBeTruthy();
    expect(screen.getByText('settings.media.videoDuration')).toBeTruthy();
    expect(screen.getByText('settings.media.generateAudio')).toBeTruthy();
    expect(screen.getByRole('option', { name: '15s' })).toBeTruthy();
  });

  it('shows speech and music defaults only for their active modules', () => {
    const detailProps = {
      providerId: 'minimax',
      provider: {
        displayName: 'MiniMax',
        hasCredentials: true,
        api: 'anthropic-messages',
        isLocalOpenAICompatible: false,
        models: [],
        availableModels: [],
        imageModels: [],
        audioModels: [{ id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD', type: 'audio' }],
        musicModels: [{ id: 'music-2.6', name: 'MiniMax Music 2.6', type: 'music' }],
        videoModels: [],
        availableImageModels: [],
        availableAudioModels: [],
        availableMusicModels: [{ id: 'music-2.6', name: 'MiniMax Music 2.6', type: 'music' }],
        availableVideoModels: [],
      },
      config: { providerDefaults: {} },
      onSaveConfig: vi.fn(async () => undefined),
      onRefresh: vi.fn(async () => undefined),
    };
    const { rerender } = render(
      <MediaProviderDetail
        {...detailProps}
        mediaType="audio"
      />,
    );

    expect(screen.queryByText('settings.media.size')).toBeNull();
    expect(screen.getByText('settings.media.audioFormat')).toBeTruthy();
    expect(screen.getByText('settings.media.audioResponseFormat')).toBeTruthy();
    expect(screen.getByText('settings.media.voiceId')).toBeTruthy();
    expect(screen.getByText('settings.media.mediaBaseUrl')).toBeTruthy();

    rerender(
      <MediaProviderDetail
        {...detailProps}
        mediaType="music"
      />,
    );

    expect(screen.queryByText('settings.media.voiceId')).toBeNull();
    expect(screen.getByText('settings.media.musicFormat')).toBeTruthy();
    expect(screen.getByText('settings.media.musicResponseFormat')).toBeTruthy();
  });

  it('removes media-only image models through the provider model endpoint', async () => {
    const onRefresh = vi.fn(async () => undefined);
    vi.mocked(codiaFetch).mockResolvedValue({
      json: async () => ({ ok: true }),
    } as Response);

    render(
      <MediaProviderDetail
        providerId="minimax"
        provider={{
          displayName: 'MiniMax',
          hasCredentials: true,
          api: 'anthropic-messages',
          isLocalOpenAICompatible: false,
          models: [],
          availableModels: [],
          imageModels: [{ id: 'image-01', name: 'MiniMax Image 01', type: 'image' }],
          audioModels: [],
          musicModels: [],
          videoModels: [],
          availableImageModels: [],
          availableAudioModels: [],
          availableMusicModels: [],
          availableVideoModels: [],
        }}
        config={{ defaultImageModel: { provider: 'minimax', id: 'image-01' }, providerDefaults: {} }}
        onSaveConfig={vi.fn(async () => undefined)}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByTitle('settings.api.removeModel'));

    await waitFor(() => {
      expect(codiaFetch).toHaveBeenCalledWith(
        '/api/plugins/image-gen/providers/minimax/models/image-01',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('adds typed audio models through the media type endpoint from preset candidates', async () => {
    const onRefresh = vi.fn(async () => undefined);
    vi.mocked(codiaFetch).mockResolvedValue({
      json: async () => ({ ok: true }),
    } as Response);

    render(
      <MediaProviderDetail
        providerId="minimax"
        mediaType="audio"
        provider={{
          displayName: 'MiniMax',
          hasCredentials: true,
          api: 'anthropic-messages',
          isLocalOpenAICompatible: false,
          models: [],
          availableModels: [],
          imageModels: [],
          audioModels: [],
          musicModels: [],
          videoModels: [],
          availableImageModels: [],
          availableAudioModels: [{ id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD', type: 'audio' }],
          availableMusicModels: [],
          availableVideoModels: [],
        }}
        config={{ providerDefaults: {} }}
        onSaveConfig={vi.fn(async () => undefined)}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /settings\.media\.addAudioModel/ }));
    fireEvent.click(screen.getByRole('button', { name: /MiniMax Speech 2\.8 HD/ }));

    await waitFor(() => {
      expect(codiaFetch).toHaveBeenCalledWith(
        '/api/providers/minimax/models/speech-2.8-hd',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ type: 'audio' }),
        }),
      );
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
