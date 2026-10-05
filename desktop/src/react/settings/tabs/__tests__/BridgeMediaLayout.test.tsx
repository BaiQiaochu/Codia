/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
  saveGlobalSettings: vi.fn(),
  saveBridgeConfig: vi.fn(),
  savePublicIshiki: vi.fn(),
  setSelectedAgentId: vi.fn(),
  setOwner: vi.fn(),
  testPlatform: vi.fn(),
  reconnectPlatform: vi.fn(),
  loadStatus: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../api', () => ({
  gsapFetch: (...args: unknown[]) => mocks.gsapFetch(...args),
}));

vi.mock('../../widgets/Toggle', () => ({
  Toggle: ({ on, onChange, label, ariaLabel }: { on: boolean; onChange: (next: boolean) => void; label?: string; ariaLabel?: string }) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel || label || (on ? 'common.on' : 'common.off')}
      onClick={() => onChange(!on)}
    >
      toggle
    </button>
  ),
}));

vi.mock('../bridge/BridgeAgentRow', () => ({
  BridgeAgentRow: () => <div data-testid="bridge-agent-row">bridge-agent-row</div>,
}));

vi.mock('../bridge/useBridgeState', () => ({
  useBridgeState: () => ({
    status: {
      telegram: { enabled: true, status: 'connected' },
      feishu: { enabled: false, status: 'disconnected' },
      qq: { enabled: false, status: 'disconnected' },
      agentlyMail: { enabled: false, status: 'disconnected', email: '' },
      wechat: { enabled: false, status: 'disconnected' },
      whatsapp: { enabled: false, status: 'disconnected', authenticated: false },
      permissionMode: 'operate',
      readOnly: false,
      receiptEnabled: true,
      richStreamingEnabled: false,
      knownUsers: {},
      owner: {},
    },
    testingPlatform: null,
    reconnectingPlatform: null,
    selectedAgentId: 'gsap',
    publicIshiki: '',
    tgToken: 'telegram-token',
    fsAppId: '',
    fsAppSecret: '',
    qqAppId: '',
    qqAppSecret: '',
    setSelectedAgentId: mocks.setSelectedAgentId,
    setPublicIshiki: vi.fn(),
    setTgToken: vi.fn(),
    setFsAppId: vi.fn(),
    setFsAppSecret: vi.fn(),
    setQqAppId: vi.fn(),
    setQqAppSecret: vi.fn(),
    saveGlobalSettings: mocks.saveGlobalSettings,
    saveBridgeConfig: mocks.saveBridgeConfig,
    savePublicIshiki: mocks.savePublicIshiki,
    testPlatform: mocks.testPlatform,
    reconnectPlatform: mocks.reconnectPlatform,
    loadStatus: mocks.loadStatus,
    setOwner: mocks.setOwner,
    showToast: mocks.showToast,
  }),
}));

import { BridgeTab } from '../BridgeTab';
import { MediaTab } from '../MediaTab';
import { useSettingsStore } from '../../store';

function expectSettingsSectionHeader(headingText: string) {
  const heading = screen.getByRole('heading', { name: headingText });
  const section = heading.closest('section');
  expect(section).toBeTruthy();
  expect(heading.parentElement).not.toBe(section);
  expect(section?.children.length).toBeGreaterThanOrEqual(2);
}

describe('settings tab layout parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gsapFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/plugins/image-gen/providers')) {
        return {
          json: async () => ({
            config: {
              defaultImageModel: { provider: 'volcengine', id: 'doubao-seedream' },
              defaultAudioModel: { provider: 'volcengine', id: 'doubao-tts' },
              defaultMusicModel: { provider: 'volcengine', id: 'doubao-music' },
              defaultVideoModel: { provider: 'volcengine', id: 'doubao-video' },
              providerDefaults: {},
            },
            providers: {
              volcengine: {
                providerId: 'volcengine',
                displayName: 'Volcengine (Doubao)',
                hasCredentials: true,
                models: [],
                availableModels: [],
                imageModels: [{ id: 'doubao-seedream', name: 'Seedream', type: 'image' }],
                audioModels: [{ id: 'doubao-tts', name: 'Doubao TTS', type: 'audio' }],
                musicModels: [{ id: 'doubao-music', name: 'Doubao Music', type: 'music' }],
                videoModels: [{ id: 'doubao-video', name: 'Doubao Video', type: 'video' }],
                availableImageModels: [],
                availableAudioModels: [],
                availableMusicModels: [],
                availableVideoModels: [],
              },
            },
          }),
        };
      }
      if (path.startsWith('/api/speech-recognition/providers')) {
        return {
          json: async () => ({
            config: {
              enabled: true,
              defaultModel: { provider: 'volcengine', id: 'doubao-asr' },
            },
            providers: {
              volcengine: {
                providerId: 'volcengine',
                displayName: 'Volcengine (Doubao)',
                hasCredentials: true,
                models: [{ id: 'doubao-asr', name: 'Doubao ASR', adapterAvailable: true }],
                availableModels: [],
              },
            },
          }),
        };
      }
      if (path.startsWith('/api/bridge/agently-mail/status')) {
        return {
          json: async () => ({
            ok: true,
            cli: {
              available: true,
              version: '1.2.3',
              installCommand: 'npm install -g @tencent-qqmail/agently-cli',
              skillInstallCommand: 'npx skills add https://agent.qq.com --skill -g -y',
            },
          }),
        };
      }
      return { json: async () => ({}) };
    });
    useSettingsStore.setState({
      ready: true,
      currentAgentId: 'gsap',
      settingsAgentId: null,
      serverPort: 52022,
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
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({
      ready: false,
      currentAgentId: null,
      settingsAgentId: null,
      serverPort: null,
    });
    vi.unstubAllGlobals();
  });

  it('keeps bridge sections in the shared settings card layout with platform toggles visible', () => {
    render(<BridgeTab />);

    expectSettingsSectionHeader('settings.bridge.globalSettings');
    expectSettingsSectionHeader('settings.bridge.agentSettings');
    expectSettingsSectionHeader('settings.bridge.telegram');
    expectSettingsSectionHeader('settings.bridge.agentlyMail');
    expectSettingsSectionHeader('settings.bridge.wechat');
    expectSettingsSectionHeader('WhatsApp');
    expect(screen.getByTestId('bridge-agent-row')).toBeTruthy();
    expect(screen.getByRole('button', { name: /settings\.bridge\.permissionModeOperate/ })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'settings.bridge.richStreamingEnabled' })).toBeTruthy();
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(7);
  });

  it('keeps media settings focused on module routing while support panels stay below defaults', async () => {
    render(<MediaTab />);

    await waitFor(() => expect(screen.getAllByText('Volcengine (Doubao)').length).toBeGreaterThan(0));

    expectSettingsSectionHeader('settings.media.globalDefault');
    expect(screen.getByTestId('media-module-image')).toBeTruthy();
    expect(screen.getByTestId('media-module-audio')).toBeTruthy();
    expect(screen.getByTestId('media-module-music')).toBeTruthy();
    expect(screen.getByTestId('media-module-video')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'settings.media.speechRecognition' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'settings.media.speechSynthesis' })).toBeTruthy();
    expect(screen.getAllByText('settings.media.defaultVideoModel').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('voice-input-device')).toBeTruthy();
    expect(screen.getByTestId('voice-synthesis-voice')).toBeTruthy();
    expect(screen.getByTestId('media-diagnostics')).toBeTruthy();
  });
});
