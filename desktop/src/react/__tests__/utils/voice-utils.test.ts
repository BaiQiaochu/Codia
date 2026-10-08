import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getVoiceRecognitionCtor,
  getVoiceSettings,
  listAudioInputDevices,
  requestAudioInputPermission,
  saveVoiceSettings,
  supportsAudioInputDevices,
  supportsVoiceRecognition,
  supportsVoiceSynthesis,
} from '../../utils/voice';

describe('voice utils', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        clear: () => storage.clear(),
      },
      i18n: { locale: 'zh-CN' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects SpeechRecognition support from browser globals', () => {
    class FakeRecognition {}
    Object.defineProperty(window, 'SpeechRecognition', {
      value: FakeRecognition,
      configurable: true,
    });

    expect(getVoiceRecognitionCtor()).toBe(FakeRecognition);
    expect(supportsVoiceRecognition()).toBe(true);
  });

  it('detects speech synthesis support from browser globals', () => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        cancel: vi.fn(),
        speak: vi.fn(),
        getVoices: vi.fn(() => []),
      },
      configurable: true,
    });

    expect(supportsVoiceSynthesis()).toBe(true);
  });

  it('persists local voice settings and keeps locale-based default language', () => {
    const saved = saveVoiceSettings({
      recognitionInputDeviceId: 'mic-usb',
      synthesisRate: 1.3,
      synthesisPitch: 0.9,
      synthesisVolume: 0.7,
      synthesisVoiceUri: 'voice://demo',
    });

    expect(saved.recognitionLang).toBe('zh-CN');
    expect(saved.recognitionInputDeviceId).toBe('mic-usb');
    expect(saved.synthesisRate).toBe(1.3);
    expect(saved.synthesisPitch).toBe(0.9);
    expect(saved.synthesisVolume).toBe(0.7);
    expect(saved.synthesisVoiceUri).toBe('voice://demo');

    const loaded = getVoiceSettings();
    expect(loaded).toMatchObject({
      recognitionLang: 'zh-CN',
      recognitionInputDeviceId: 'mic-usb',
      synthesisRate: 1.3,
      synthesisPitch: 0.9,
      synthesisVolume: 0.7,
      synthesisVoiceUri: 'voice://demo',
    });
  });

  it('enumerates audio input devices and requests temporary microphone permission', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }));
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'default', label: '', groupId: 'grp-default' },
      { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB Mic', groupId: 'grp-usb' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'grp-cam' },
    ]);

    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });

    expect(supportsAudioInputDevices()).toBe(true);
    await expect(listAudioInputDevices()).resolves.toEqual([
      { deviceId: 'default', label: 'Microphone 1', groupId: 'grp-default' },
      { deviceId: 'mic-usb', label: 'USB Mic', groupId: 'grp-usb' },
    ]);

    await requestAudioInputPermission('mic-usb');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-usb' } } });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
