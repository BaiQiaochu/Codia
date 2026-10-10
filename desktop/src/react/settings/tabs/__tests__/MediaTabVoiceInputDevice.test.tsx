/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  codiaFetch: vi.fn(),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../api', () => ({
  codiaFetch: (...args: unknown[]) => mocks.codiaFetch(...args),
}));

import { MediaTab } from '../MediaTab';
import { useSettingsStore } from '../../store';

describe('MediaTab voice input device selection', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useSettingsStore.setState({
      ready: true,
      currentAgentId: 'codia',
      settingsAgentId: null,
      serverPort: 52022,
    });
    mocks.codiaFetch.mockResolvedValue({
      json: async () => ({
        providers: {},
        config: {},
      }),
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', deviceId: 'default', label: 'Default microphone', groupId: 'group-default' },
          { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB Mic', groupId: 'group-usb' },
        ]),
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
    });

    Object.assign(window, {
      i18n: { locale: 'zh-CN' },
      speechSynthesis: {
        getVoices: vi.fn(() => [
          { voiceURI: 'voice://demo', name: 'Demo Voice', lang: 'zh-CN' },
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        cancel: vi.fn(),
        speak: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps local microphone and speech synthesis controls available in the media shell', async () => {
    render(<MediaTab />);

    expect(await screen.findByText('settings.media.imageGeneration')).toBeTruthy();
    expect(screen.getAllByText('settings.media.speechRecognition').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('settings.media.speechSynthesis').length).toBeGreaterThanOrEqual(2);

    const deviceSelect = await screen.findByTestId('voice-input-device') as HTMLSelectElement;
    expect([...deviceSelect.options].map(option => option.textContent)).toContain('USB Mic');

    fireEvent.change(deviceSelect, { target: { value: 'mic-usb' } });
    expect(JSON.parse(localStorage.getItem('codia-voice-settings') || '{}').recognitionInputDeviceId).toBe('mic-usb');

    fireEvent.click(screen.getByTestId('voice-input-refresh'));
    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-usb' } } });
    });

    const voiceSelect = screen.getByTestId('voice-synthesis-voice') as HTMLSelectElement;
    expect([...voiceSelect.options].some(option => option.textContent?.includes('Demo Voice'))).toBe(true);
  });
});
