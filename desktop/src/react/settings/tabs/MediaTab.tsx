import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { gsapFetch } from '../api';
import { t } from '../helpers';
import { getErrorMessage, type ImageGenConfigPayload } from '../shared-types';
import { MediaProviderDetail } from './media/MediaProviderDetail';
import { SettingsSection } from '../components/SettingsSection';
import {
  collectActualDefaultModels,
  sanitizeDefaultMediaConfig,
  type MediaModelWithProvider,
  type MediaType,
} from './media/media-default-models';
import {
  getVoiceSettings,
  listAudioInputDevices,
  requestAudioInputPermission,
  saveVoiceSettings,
  supportsAudioInputDevices,
  supportsVoiceRecognition,
  supportsVoiceSynthesis,
  type AudioInputDevice,
  type VoiceSettings,
} from '../../utils/voice';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';

function css(...names: Array<string | false | null | undefined>) {
  return names
    .flatMap(name => (name ? [styles[name], name] : []))
    .filter(Boolean)
    .join(' ');
}

interface MediaModel {
  id: string;
  name: string;
  type?: string;
}

interface MediaProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  baseUrl?: string;
  api?: string;
  isLocalOpenAICompatible?: boolean;
  models: MediaModel[];
  availableModels: MediaModel[];
  imageModels?: MediaModel[];
  audioModels?: MediaModel[];
  musicModels?: MediaModel[];
  videoModels?: MediaModel[];
  availableImageModels?: MediaModel[];
  availableAudioModels?: MediaModel[];
  availableMusicModels?: MediaModel[];
  availableVideoModels?: MediaModel[];
}

interface SpeechModel {
  id: string;
  name?: string;
  displayName?: string;
  adapterAvailable?: boolean;
}

interface SpeechProvider {
  providerId: string;
  displayName?: string;
  hasCredentials?: boolean;
  unavailableReason?: string | null;
  models?: SpeechModel[];
  availableModels?: SpeechModel[];
}

interface SpeechConfig {
  enabled: boolean;
  defaultModel?: { provider: string; id: string };
}

type SpeechConfigPatch = {
  enabled?: boolean;
  defaultModel?: SpeechConfig['defaultModel'] | null;
};

type DefaultMediaConfigKey = 'defaultImageModel' | 'defaultAudioModel' | 'defaultMusicModel' | 'defaultVideoModel';

const MEDIA_DIAGNOSTIC_TYPES: Array<{ type: MediaType; labelKey: string; configKey: DefaultMediaConfigKey }> = [
  { type: 'image', labelKey: 'settings.media.defaultImageModel', configKey: 'defaultImageModel' },
  { type: 'audio', labelKey: 'settings.media.defaultAudioModel', configKey: 'defaultAudioModel' },
  { type: 'music', labelKey: 'settings.media.defaultMusicModel', configKey: 'defaultMusicModel' },
  { type: 'video', labelKey: 'settings.media.defaultVideoModel', configKey: 'defaultVideoModel' },
];

const MEDIA_MODULES: Array<{ type: MediaType; labelKey: string; providerLabelKey: string }> = [
  { type: 'image', labelKey: 'settings.media.imageModels', providerLabelKey: 'settings.media.imageGeneration' },
  { type: 'audio', labelKey: 'settings.media.audioModels', providerLabelKey: 'settings.media.audioModels' },
  { type: 'music', labelKey: 'settings.media.musicModels', providerLabelKey: 'settings.media.musicModels' },
  { type: 'video', labelKey: 'settings.media.videoModels', providerLabelKey: 'settings.media.videoModels' },
];

const RECOGNITION_LANG_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en-US', label: '英语（美国）' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
];

function mergeProviderModelsForType(provider: MediaProvider, type: MediaType) {
  const seen = new Set<string>();
  return actualModelsForType(provider, type).filter((model) => {
    if (!model?.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function actualModelsForType(provider: MediaProvider, type: MediaType) {
  if (type === 'audio') return provider.audioModels || [];
  if (type === 'music') return provider.musicModels || [];
  if (type === 'video') return provider.videoModels || [];
  return provider.imageModels || [];
}

function availableModelsForType(provider: MediaProvider, type: MediaType) {
  if (type === 'audio') return provider.availableAudioModels || [];
  if (type === 'music') return provider.availableMusicModels || [];
  if (type === 'video') return provider.availableVideoModels || [];
  if (provider.availableImageModels) return provider.availableImageModels;
  return (provider.availableModels || []).filter(model => model?.type === 'image');
}

function collectCandidateOnlyModels(providers: Record<string, MediaProvider>, type: MediaType): MediaModelWithProvider[] {
  const result: MediaModelWithProvider[] = [];
  const seen = new Set<string>();

  for (const [providerId, provider] of Object.entries(providers || {})) {
    const actualIds = new Set(actualModelsForType(provider, type).map(model => model.id));
    for (const model of availableModelsForType(provider, type)) {
      if (!model?.id || actualIds.has(model.id)) continue;
      const key = `${type}:${providerId}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...model, provider: providerId });
    }
  }

  return result;
}

function formatModelRef(model: { provider: string; id: string } | null | undefined) {
  if (!model?.provider || !model?.id) return '';
  return `${model.provider}/${model.id}`;
}

function textOrFallback(key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function applySpeechConfigPatch(prev: SpeechConfig, updates: SpeechConfigPatch): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof updates.enabled === 'boolean') next.enabled = updates.enabled;
  if ('defaultModel' in updates) {
    if (updates.defaultModel) next.defaultModel = updates.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function mergeSpeechConfig(prev: SpeechConfig, incoming: any): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof incoming?.enabled === 'boolean') next.enabled = incoming.enabled;
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'defaultModel')) {
    if (incoming.defaultModel) next.defaultModel = incoming.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function getRunnableSpeechModels(provider: SpeechProvider | undefined): SpeechModel[] {
  return (provider?.models || [])
    .filter(model => model?.id && model.adapterAvailable !== false);
}

function speechModelLabel(model: SpeechModel & { provider: string }): string {
  return `${model.provider} / ${model.displayName || model.name || model.id}`;
}

export function MediaTab() {
  const [providers, setProviders] = useState<Record<string, MediaProvider>>({});
  const [config, setConfig] = useState<ImageGenConfigPayload | null>(null);
  const [imageConfigLoading, setImageConfigLoading] = useState(true);
  const [speechProviders, setSpeechProviders] = useState<Record<string, SpeechProvider>>({});
  const [speechConfig, setSpeechConfig] = useState<SpeechConfig | null>(null);
  const [speechConfigLoading, setSpeechConfigLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeMediaType, setActiveMediaType] = useState<MediaType>('image');
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() => getVoiceSettings());
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [audioInputsRefreshing, setAudioInputsRefreshing] = useState(false);
  const { showToast } = useSettingsStore();
  const settingsReady = useSettingsStore(state => state.ready);
  const settingsAgentId = useSettingsStore(state => state.settingsAgentId);
  const currentAgentId = useSettingsStore(state => state.currentAgentId);
  const serverPort = useSettingsStore(state => state.serverPort);
  const activeAgentId = settingsAgentId || currentAgentId;

  const load = useCallback(async () => {
    if (!activeAgentId || !serverPort) return;
    setImageConfigLoading(true);
    try {
      const res = await gsapFetch(`/api/plugins/image-gen/providers?agentId=${activeAgentId}`);
      const data = await res.json();
      const nextProviders = data.providers || {};
      const nextProviderIds = Object.keys(nextProviders);
      const sanitized = sanitizeDefaultMediaConfig(data.config || {}, nextProviders);
      setProviders(nextProviders);
      setConfig(sanitized.config);
      setSelected(prev => (prev && nextProviders[prev] ? prev : nextProviderIds[0] || null));
      if (Object.keys(sanitized.updates).length > 0) {
        try {
          await gsapFetch(`/api/plugins/image-gen/config?agentId=${activeAgentId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: sanitized.updates }),
          });
        } catch (err) {
          console.warn('[media-settings] failed to clear stale default media models', err);
        }
      }
    } catch (err) {
      console.warn('[media-settings] failed to load image-gen providers', err);
      setProviders({});
      setConfig(prev => prev || {});
      setSelected(null);
    } finally {
      setImageConfigLoading(false);
    }
  }, [activeAgentId, serverPort]);

  const loadSpeechProviders = useCallback(async () => {
    if (!serverPort) return;
    setSpeechConfigLoading(true);
    try {
      const res = await gsapFetch('/api/speech-recognition/providers');
      const data = await res.json();
      setSpeechProviders(data.providers || {});
      setSpeechConfig(mergeSpeechConfig({ enabled: false }, data.config || {}));
    } catch (err) {
      console.warn('[media-settings] failed to load speech recognition providers', err);
      setSpeechProviders({});
      setSpeechConfig({ enabled: false });
    } finally {
      setSpeechConfigLoading(false);
    }
  }, [serverPort]);

  useEffect(() => {
    if (!settingsReady || !activeAgentId || !serverPort) return;
    load();
    void loadSpeechProviders();
  }, [activeAgentId, load, loadSpeechProviders, serverPort, settingsReady]);

  const loadAudioInputs = useCallback(async () => {
    if (!supportsAudioInputDevices()) {
      setAudioInputs([]);
      return;
    }
    const devices = await listAudioInputDevices();
    setAudioInputs(devices);
  }, []);

  const loadSpeechVoices = useCallback(() => {
    if (!supportsVoiceSynthesis()) {
      setSpeechVoices([]);
      return;
    }
    setSpeechVoices(window.speechSynthesis.getVoices() || []);
  }, []);

  useEffect(() => {
    void loadAudioInputs().catch(() => setAudioInputs([]));
  }, [loadAudioInputs]);

  useEffect(() => {
    loadSpeechVoices();
    if (!supportsVoiceSynthesis()) return undefined;
    window.speechSynthesis.addEventListener?.('voiceschanged', loadSpeechVoices);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', loadSpeechVoices);
  }, [loadSpeechVoices]);

  const providerIds = Object.keys(providers);
  const visibleProviderIds = useMemo(
    () => providerIds.filter(pid => mergeProviderModelsForType(providers[pid], activeMediaType).length > 0),
    [activeMediaType, providerIds.join('\0'), providers],
  );
  const visibleProviderSignature = visibleProviderIds.join('\0');
  const mediaConfig = config || {};
  const speechConfigValue = speechConfig || { enabled: false };
  const activeMediaModule = MEDIA_MODULES.find(module => module.type === activeMediaType) || MEDIA_MODULES[0];
  const allImageModels = collectActualDefaultModels(providers, 'image');
  const allAudioModels = collectActualDefaultModels(providers, 'audio');
  const allMusicModels = collectActualDefaultModels(providers, 'music');
  const allVideoModels = collectActualDefaultModels(providers, 'video');
  const speechProviderIds = Object.keys(speechProviders);
  const allSpeechModels = speechProviderIds.flatMap(providerId =>
    getRunnableSpeechModels(speechProviders[providerId]).map(model => ({ ...model, provider: providerId })),
  );
  const speechEnabled = speechConfig ? speechConfig.enabled === true : undefined;
  const speechRecognitionEnabledLabel = textOrFallback('settings.media.speechRecognitionEnabled', '发送语音时自动转写');
  const defaultSpeechModelLabel = textOrFallback('settings.media.defaultSpeechModel', '默认转写模型');
  const mediaDiagnostics = useMemo(() => MEDIA_DIAGNOSTIC_TYPES.map(entry => ({
    ...entry,
    defaultModel: formatModelRef(mediaConfig[entry.configKey]),
    actualModels: collectActualDefaultModels(providers, entry.type),
    candidateOnlyModels: collectCandidateOnlyModels(providers, entry.type),
  })), [mediaConfig, providers]);
  const voiceRecognitionAvailable = supportsVoiceRecognition() || supportsAudioInputDevices();
  const voiceSynthesisAvailable = supportsVoiceSynthesis();
  const selectedAudioInputMissing = !!voiceSettings.recognitionInputDeviceId
    && !audioInputs.some(device => device.deviceId === voiceSettings.recognitionInputDeviceId);

  useEffect(() => {
    setSelected(prev => (prev && visibleProviderIds.includes(prev) ? prev : visibleProviderIds[0] || null));
  }, [visibleProviderSignature]);

  const saveConfig = async (updates: Partial<ImageGenConfigPayload>) => {
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      await gsapFetch(`/api/plugins/image-gen/config?agentId=${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: updates }),
      });
      setConfig(prev => ({ ...(prev || {}), ...updates }));
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(getErrorMessage(err) || 'Save failed', 'error');
    }
  };

  const saveSpeechConfig = async (updates: SpeechConfigPatch) => {
    try {
      const res = await gsapFetch('/api/speech-recognition/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: updates }),
      });
      const data = await res.json().catch(() => null);
      if (data?.config) {
        setSpeechConfig(mergeSpeechConfig(speechConfig || { enabled: false }, data.config));
      } else {
        setSpeechConfig(prev => applySpeechConfigPatch(prev || { enabled: false }, updates));
      }
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(getErrorMessage(err) || 'Save failed', 'error');
    }
  };

  const updateVoiceSettings = (updates: Partial<VoiceSettings>) => {
    setVoiceSettings(saveVoiceSettings(updates));
  };

  const refreshAudioInputs = async () => {
    setAudioInputsRefreshing(true);
    try {
      await requestAudioInputPermission(voiceSettings.recognitionInputDeviceId);
      await loadAudioInputs();
    } catch (err: unknown) {
      showToast(getErrorMessage(err) || t('settings.media.voicePermissionDenied'), 'error');
    } finally {
      setAudioInputsRefreshing(false);
    }
  };

  const testSpeechPlayback = () => {
    if (!supportsVoiceSynthesis() || typeof SpeechSynthesisUtterance === 'undefined') {
      showToast(t('settings.media.unsupported'), 'error');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(t('settings.media.testPlayback'));
    utterance.lang = voiceSettings.recognitionLang || window.i18n?.locale || 'zh-CN';
    utterance.rate = voiceSettings.synthesisRate || 1;
    utterance.pitch = voiceSettings.synthesisPitch || 1;
    utterance.volume = voiceSettings.synthesisVolume || 1;
    if (voiceSettings.synthesisVoiceUri) {
      const voice = speechVoices.find(item => item.voiceURI === voiceSettings.synthesisVoiceUri);
      if (voice) utterance.voice = voice;
    }
    window.speechSynthesis.speak(utterance);
  };

  const exportMediaDiagnostics = () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      defaults: {
        defaultImageModel: mediaConfig.defaultImageModel || null,
        defaultAudioModel: mediaConfig.defaultAudioModel || null,
        defaultMusicModel: mediaConfig.defaultMusicModel || null,
        defaultVideoModel: mediaConfig.defaultVideoModel || null,
      },
      diagnostics: mediaDiagnostics.map(row => ({
        type: row.type,
        defaultModel: row.defaultModel || null,
        actualModels: row.actualModels,
        candidateOnlyModels: row.candidateOnlyModels,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    // eslint-disable-next-line no-restricted-syntax -- Hidden anchor is the browser download trigger for this diagnostics JSON.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gsap-media-diagnostics-${Date.now()}.json`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast(t('settings.media.exportDiagnosticsSuccess'), 'success');
  };

  const renderDefaultSelector = (
    label: string,
    configKey: DefaultMediaConfigKey,
    models: MediaModelWithProvider[],
  ) => {
    const current = mediaConfig[configKey] as { provider?: string; id?: string } | null | undefined;
    return (
      <div className={css('media-default-field')} data-testid={`media-default-field-${configKey}`}>
        <label className={css('media-default-label')} htmlFor={`media-${configKey}`}>
          {label}
        </label>
        <div className={css('media-default-control-wrap')}>
          <select
            id={`media-${configKey}`}
            className={css('media-default-select')}
            value={current ? `${current.provider}/${current.id}` : ''}
            disabled={imageConfigLoading}
            data-testid={`media-${configKey}`}
            onChange={(e) => {
              const val = e.target.value;
              if (!val) {
                saveConfig({ [configKey]: null });
                return;
              }
              const [provider, ...rest] = val.split('/');
              saveConfig({ [configKey]: { id: rest.join('/'), provider } });
            }}
          >
            <option value="">-</option>
            {models.map(m => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.provider} / {m.name || m.id}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  };

  return (
    <div className={css('settings-tab-content', 'active')} data-tab="media">
      <SettingsSection variant="double-column">
        <div className={css('pv-layout')}>
          <div className={css('pv-list')}>
            <div className={css('media-module-switcher')} aria-label={t('settings.media.globalDefault')}>
              {MEDIA_MODULES.map(module => (
                <button
                  type="button"
                  key={module.type}
                  data-testid={`media-module-${module.type}`}
                  aria-pressed={activeMediaType === module.type}
                  className={css('media-module-button', activeMediaType === module.type && 'media-module-button-selected')}
                  onClick={() => setActiveMediaType(module.type)}
                >
                  {t(module.labelKey)}
                </button>
              ))}
            </div>
            <div className={css('pv-list-group-label')}>{t(activeMediaModule.providerLabelKey)}</div>
            {visibleProviderIds.map(pid => {
              const p = providers[pid];
              const modelCount = mergeProviderModelsForType(p, activeMediaType).length;
              return (
                <button
                  type="button"
                  key={pid}
                  className={css('pv-list-item', selected === pid && 'pv-list-item-selected', !p.hasCredentials && 'pv-list-item-dim')}
                  onClick={() => setSelected(pid)}
                >
                  <span className={css('pv-status-dot', p.hasCredentials && 'on')} />
                  <span className={css('pv-list-item-name')}>{p.displayName || pid}</span>
                  <span className={css('pv-list-item-count')}>{modelCount}</span>
                </button>
              );
            })}
            {visibleProviderIds.length === 0 && (
              <div className={css('pv-list-empty')}>
                {t('settings.media.noActualModels')}
              </div>
            )}
          </div>

          <div className={css('pv-detail')}>
            {selected && providers[selected] ? (
              <MediaProviderDetail
                providerId={selected}
                mediaType={activeMediaType}
                provider={providers[selected]}
                config={mediaConfig}
                onSaveConfig={saveConfig}
                onRefresh={load}
              />
            ) : (
              <div className={css('pv-empty')}>
                {t('settings.media.noProvider')}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.media.globalDefault')} className={css('pv-other-section')}>
        <div className={css('media-defaults-grid')} data-testid="media-defaults-grid">
          {renderDefaultSelector(t('settings.media.defaultImageModel'), 'defaultImageModel', allImageModels)}
          {renderDefaultSelector(t('settings.media.defaultAudioModel'), 'defaultAudioModel', allAudioModels)}
          {renderDefaultSelector(t('settings.media.defaultMusicModel'), 'defaultMusicModel', allMusicModels)}
          {renderDefaultSelector(t('settings.media.defaultVideoModel'), 'defaultVideoModel', allVideoModels)}
        </div>
      </SettingsSection>

      <div className={css('media-support-nav')} aria-label={t('settings.media.scanDiagnostics')}>
        <a className={css('media-support-nav-item')} href="#media-speech-recognition">
          {t('settings.media.speechRecognition')}
        </a>
        <a className={css('media-support-nav-item')} href="#media-speech-synthesis">
          {t('settings.media.speechSynthesis')}
        </a>
        <a className={css('media-support-nav-item')} href="#media-scan-diagnostics">
          {t('settings.media.scanDiagnostics')}
        </a>
      </div>

      <div className={css('media-support-grid')}>
        <div id="media-speech-recognition">
          <SettingsSection title={t('settings.media.speechRecognition')} className={css('pv-other-section')}>
            <div className={css('media-voice-grid')}>
              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="speech-recognition-enabled">
                  {speechRecognitionEnabledLabel}
                </label>
                <div className={css('media-default-control-wrap')}>
                  <Toggle
                    label={speechRecognitionEnabledLabel}
                    on={speechEnabled}
                    disabled={speechConfigLoading}
                    onChange={(enabled) => { void saveSpeechConfig({ enabled }); }}
                  />
                </div>
              </div>

              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="speech-recognition-default-model">
                  {defaultSpeechModelLabel}
                </label>
                <select
                  id="speech-recognition-default-model"
                  data-testid="speech-recognition-default-model"
                  className={css('media-default-select')}
                  value={speechConfigValue.defaultModel ? `${speechConfigValue.defaultModel.provider}/${speechConfigValue.defaultModel.id}` : ''}
                  disabled={speechEnabled !== true || speechConfigLoading || allSpeechModels.length === 0}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) {
                      void saveSpeechConfig({ defaultModel: null });
                      return;
                    }
                    const [provider, ...rest] = val.split('/');
                    void saveSpeechConfig({ defaultModel: { provider, id: rest.join('/') } });
                  }}
                >
                  <option value="">-</option>
                  {allSpeechModels.map(model => (
                    <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                      {speechModelLabel(model)}
                    </option>
                  ))}
                </select>
              </div>

              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="voice-recognition-language">
                  {t('settings.media.recognitionLanguage')}
                </label>
                <select
                  id="voice-recognition-language"
                  data-testid="voice-recognition-language"
                  className={css('media-default-select')}
                  value={voiceSettings.recognitionLang}
                  onChange={(e) => updateVoiceSettings({ recognitionLang: e.target.value })}
                >
                  {RECOGNITION_LANG_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="voice-input-device">
                  {t('settings.media.voiceInputDevice')}
                </label>
                <select
                  id="voice-input-device"
                  data-testid="voice-input-device"
                  className={css('media-default-select')}
                  value={voiceSettings.recognitionInputDeviceId}
                  onChange={(e) => updateVoiceSettings({ recognitionInputDeviceId: e.target.value })}
                >
                  <option value="">{t('settings.media.systemDefaultInput')}</option>
                  {selectedAudioInputMissing && (
                    <option value={voiceSettings.recognitionInputDeviceId}>
                      {voiceSettings.recognitionInputDeviceId} ({t('settings.media.voiceDeviceUnavailable')})
                    </option>
                  )}
                  {audioInputs.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || device.deviceId}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className={css('media-inline-actions')}>
              <button
                type="button"
                className={css('media-action-button')}
                data-testid="voice-input-refresh"
                disabled={audioInputsRefreshing || !supportsAudioInputDevices()}
                onClick={() => { void refreshAudioInputs(); }}
              >
                {audioInputsRefreshing ? t('settings.media.refreshingAudioInputs') : t('settings.media.refreshAudioInputs')}
              </button>
              <span className={css('media-muted-text')}>
                {voiceRecognitionAvailable ? t('settings.media.supported') : t('settings.media.voiceNotSupported')}
              </span>
            </div>
          </SettingsSection>
        </div>

        <div id="media-speech-synthesis">
          <SettingsSection title={t('settings.media.speechSynthesis')} className={css('pv-other-section')}>
            <div className={css('media-voice-grid')}>
              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="voice-synthesis-voice">
                  {t('settings.media.voiceOption')}
                </label>
                <select
                  id="voice-synthesis-voice"
                  data-testid="voice-synthesis-voice"
                  className={css('media-default-select')}
                  value={voiceSettings.synthesisVoiceUri}
                  onChange={(e) => updateVoiceSettings({ synthesisVoiceUri: e.target.value })}
                >
                  <option value="">{t('settings.media.default')}</option>
                  {speechVoices.map(voice => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.name}{voice.lang ? ` (${voice.lang})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="voice-synthesis-rate">
                  {t('settings.media.rate')}: {voiceSettings.synthesisRate.toFixed(1)}
                </label>
                <input
                  id="voice-synthesis-rate"
                  data-testid="voice-synthesis-rate"
                  className={css('media-range')}
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={voiceSettings.synthesisRate}
                  onChange={(e) => updateVoiceSettings({ synthesisRate: Number(e.target.value) })}
                />
              </div>

              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="voice-synthesis-pitch">
                  {t('settings.media.pitch')}: {voiceSettings.synthesisPitch.toFixed(1)}
                </label>
                <input
                  id="voice-synthesis-pitch"
                  data-testid="voice-synthesis-pitch"
                  className={css('media-range')}
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={voiceSettings.synthesisPitch}
                  onChange={(e) => updateVoiceSettings({ synthesisPitch: Number(e.target.value) })}
                />
              </div>

              <div className={css('media-default-field')}>
                <label className={css('media-default-label')} htmlFor="voice-synthesis-volume">
                  {t('settings.media.volume')}: {voiceSettings.synthesisVolume.toFixed(1)}
                </label>
                <input
                  id="voice-synthesis-volume"
                  data-testid="voice-synthesis-volume"
                  className={css('media-range')}
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={voiceSettings.synthesisVolume}
                  onChange={(e) => updateVoiceSettings({ synthesisVolume: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className={css('media-inline-actions')}>
              <button
                type="button"
                className={css('media-action-button')}
                data-testid="voice-synthesis-test"
                disabled={!voiceSynthesisAvailable}
                onClick={testSpeechPlayback}
              >
                {t('settings.media.testPlayback')}
              </button>
              <span className={css('media-muted-text')}>
                {voiceSynthesisAvailable ? t('settings.media.supported') : t('settings.media.unsupported')}
              </span>
            </div>
          </SettingsSection>
        </div>
      </div>

      <div id="media-scan-diagnostics">
        <SettingsSection title={t('settings.media.scanDiagnostics')} className={css('pv-other-section')}>
        <div className={css('media-diagnostics')} data-testid="media-diagnostics">
          <div className={css('media-diagnostics-header')}>
            <p className={css('media-diagnostics-hint')}>{t('settings.media.scanDiagnosticsHint')}</p>
            <button
              type="button"
              className={css('media-action-button')}
              data-testid="media-diagnostics-export"
              onClick={exportMediaDiagnostics}
            >
              {t('settings.media.exportDiagnostics')}
            </button>
          </div>
          <div className={css('media-diagnostics-grid')}>
            {mediaDiagnostics.map(row => (
              <div
                key={row.type}
                className={css('media-diagnostics-row')}
                data-testid={`media-diagnostics-${row.type}`}
              >
                <div className={css('media-diagnostics-title')}>{t(row.labelKey)}</div>
                <div className={css('media-diagnostics-line')}>
                  <span>{t('settings.media.scanDiagnosticsDefault')}</span>
                  <strong>{row.defaultModel || t('settings.media.scanDiagnosticsNone')}</strong>
                </div>
                <div className={css('media-diagnostics-line')}>
                  <span>{t('settings.media.scanDiagnosticsActual')}</span>
                  <strong>{row.actualModels.length}</strong>
                </div>
                <div className={css('media-diagnostics-line')}>
                  <span>{t('settings.media.scanDiagnosticsCandidateOnly')}</span>
                  <strong>{row.candidateOnlyModels.length}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        </SettingsSection>
      </div>
    </div>
  );
}
