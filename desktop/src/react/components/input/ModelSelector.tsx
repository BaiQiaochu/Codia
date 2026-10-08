import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { loadModels } from '../../utils/ui-helpers';
import { inferModelKind } from '../../settings/model-kind';
import { modelSupportsImageInput } from '../../utils/model-capabilities';
import { isPwaRuntime } from '../../pwa-runtime';
import { ProviderGroupHeader, SelectWidget, selectWidgetStyles, type SelectOption } from '../../ui';
import styles from './InputArea.module.css';

type ModelOption = {
  id: string;
  name: string;
  provider?: string;
  type?: string;
  isCurrent?: boolean;
  input?: string[];
  vision?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
};

type SessionModelOption = {
  id: string;
  name: string;
  provider: string;
  type?: string;
  input?: string[];
  vision?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
};

type ModelSelectOption = SelectOption & {
  kind: 'chat' | 'video';
  provider?: string;
  modelId: string;
  visionCapable?: boolean;
};

export type ChatVideoMode = {
  id: string;
  label: string;
  provider: string;
  model: string;
  mediaType: 'video';
};

let modelSwitchVersion = 0;

function modelValue(kind: 'chat' | 'video', model: { id: string; provider?: string }) {
  return `${kind}:${model.provider || ''}/${model.id}`;
}

function toChatVideoMode(model: ModelOption): ChatVideoMode {
  const provider = model.provider || '';
  return {
    id: modelValue('video', model),
    label: model.name || model.id,
    provider,
    model: model.id,
    mediaType: 'video',
  };
}

export function ModelSelector({
  models,
  sessionModel,
  isStreaming = false,
  activeChatVideoMode = null,
  onChatVideoModeChange,
}: {
  models: ModelOption[];
  sessionModel?: SessionModelOption;
  isStreaming?: boolean;
  activeChatVideoMode?: ChatVideoMode | null;
  onChatVideoModeChange?: (mode: ChatVideoMode | null) => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const activeSwitchRef = useRef<number | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeSwitchRef.current === modelSwitchVersion) {
        modelSwitchVersion += 1;
        useStore.getState().setModelSwitching(false);
      }
      activeSwitchRef.current = null;
    };
  }, []);
  const modelLocked = isPwaRuntime();

  const notifySwitchWhileStreaming = useCallback(() => {
    useStore.getState().addToast(t('model.switchWhileStreaming'), 'warning', 4000, {
      dedupeKey: 'model-switch-streaming',
    });
  }, [t]);

  const chatModels = useMemo(() => (
    models.filter((model) => inferModelKind(model.id, model.provider, model.type) === 'chat')
  ), [models]);

  const videoModels = useMemo(() => (
    models.filter((model) => inferModelKind(model.id, model.provider, model.type) === 'video')
  ), [models]);

  const matchedSessionModel = sessionModel
    ? chatModels.find((model) => model.id === sessionModel.id && model.provider === sessionModel.provider)
    : undefined;

  const current = sessionModel
    ? (matchedSessionModel ? { ...matchedSessionModel, ...sessionModel } : sessionModel)
    : chatModels.find((model) => model.isCurrent);

  const sessionModelUnavailable = !!(
    sessionModel?.id
    && sessionModel.provider
    && chatModels.length > 0
    && !matchedSessionModel
  );

  const capabilityLabel = useCallback((isVisionCapable: boolean) => {
    if (isVisionCapable) {
      const label = t('settings.providers.vision');
      return label === 'settings.providers.vision' ? '视觉' : label;
    }
    const label = t('model.textOnly');
    return label === 'model.textOnly' ? '文本' : label;
  }, [t]);

  const videoLabel = useMemo(() => {
    const label = t('settings.media.video');
    return label === 'settings.media.video' ? '视频' : label;
  }, [t]);

  const switchModel = useCallback(async (modelId: string, provider?: string) => {
    if (isStreaming) {
      notifySwitchWhileStreaming();
      return;
    }

    const state = useStore.getState();
    const { currentSessionPath, currentAgentId, activeServerConnectionId, sessionModelsByPath } = state;
    if (currentSessionPath) {
      const sm = sessionScopedValue(state, sessionModelsByPath, currentSessionPath);
      const cur = sm?.id && sm?.provider ? sm : chatModels.find((model) => model.isCurrent);
      if (cur && modelId === cur.id && (provider || '') === (cur.provider || '')) {
        onChatVideoModeChange?.(null);
        return;
      }
    }

    const myVersion = ++modelSwitchVersion;
    activeSwitchRef.current = myVersion;
    const isCurrent = () => {
      const latest = useStore.getState();
      return mountedRef.current
        && myVersion === modelSwitchVersion
        && latest.currentSessionPath === currentSessionPath
        && latest.currentAgentId === currentAgentId
        && latest.activeServerConnectionId === activeServerConnectionId;
    };
    setLoading(true);
    useStore.getState().setModelSwitching(!!currentSessionPath);

    try {
      if (currentSessionPath) {
        const res = await gsapFetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionPath: currentSessionPath, modelId, provider }),
        });
        const data = await res.json();
        if (!isCurrent()) return;
        if (!res.ok) throw new Error(data.error || 'switch failed');

        if (data.model) {
          useStore.getState().updateSessionModel(currentSessionPath, data.model);
        }
        onChatVideoModeChange?.(null);
        if (data.thinkingLevel) {
          useStore.getState().setThinkingLevel(data.thinkingLevel);
        }
        useStore.setState({ pendingNewSession: false, welcomeVisible: false });

        await loadModels({ sessionPath: currentSessionPath });
        if (!isCurrent()) return;

        if (data.adaptations?.length) {
          const msgs: Record<string, string> = {
            compacted: '已压缩对话历史以适配新模型',
            truncated: '已截断较早消息以适配新模型',
          };
          const text = data.adaptations.map((adaptation: string) => msgs[adaptation] || adaptation).join('；');
          useStore.getState().addToast(text, 'info');
        }
      } else {
        onChatVideoModeChange?.(null);
        const setRes = await gsapFetch('/api/models/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, provider }),
        });
        const setData = await setRes.json().catch(() => ({}));
        if (!isCurrent()) return;
        if (setData.thinkingLevel) {
          useStore.getState().setThinkingLevel(setData.thinkingLevel);
          useStore.getState().setPendingNewSessionThinkingLevel(setData.thinkingLevel);
        }
        await loadModels({ sessionPath: null });
      }
    } catch (err) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('model.switchFailed');
      if (message.includes('cannot switch model while streaming')) {
        notifySwitchWhileStreaming();
      } else {
        console.error('[model] switch failed:', err);
        useStore.getState().addToast(message || t('model.switchFailed'), 'error');
      }
    } finally {
      if (mountedRef.current && activeSwitchRef.current === myVersion) {
        setLoading(false);
      }
      if (myVersion === modelSwitchVersion) {
        useStore.getState().setModelSwitching(false);
      }
      if (activeSwitchRef.current === myVersion) activeSwitchRef.current = null;
    }
  }, [chatModels, isStreaming, notifySwitchWhileStreaming, onChatVideoModeChange, t]);

  const options = useMemo<ModelSelectOption[]>(() => {
    const chatOptions = chatModels.map((model) => {
      const isVisionCapable = modelSupportsImageInput(model);
      return {
        kind: 'chat' as const,
        value: modelValue('chat', model),
        label: model.name || model.id,
        provider: model.provider || '',
        modelId: model.id,
        group: model.provider || '其他',
        description: capabilityLabel(isVisionCapable),
        visionCapable: isVisionCapable,
      };
    });

    if (
      current
      && !sessionModelUnavailable
      && inferModelKind(current.id, current.provider, current.type) === 'chat'
      && !chatOptions.find((option) => option.value === modelValue('chat', current))
    ) {
      const isVisionCapable = modelSupportsImageInput(current);
      chatOptions.unshift({
        kind: 'chat',
        value: modelValue('chat', current),
        label: current.name || current.id,
        provider: current.provider || '',
        modelId: current.id,
        group: current.provider || '其他',
        description: capabilityLabel(isVisionCapable),
        visionCapable: isVisionCapable,
      });
    }

    if (modelLocked || videoModels.length === 0) return chatOptions;

    const videoOptions = videoModels.map((model) => ({
      kind: 'video' as const,
      value: modelValue('video', model),
      label: model.name || model.id,
      provider: model.provider || '',
      modelId: model.id,
      group: model.provider || '其他',
      description: videoLabel,
      visionCapable: false,
    }));

    return [...chatOptions, ...videoOptions];
  }, [capabilityLabel, chatModels, current, modelLocked, sessionModelUnavailable, videoLabel, videoModels]);

  const optionByValue = useMemo(() => {
    const map = new Map<string, ModelSelectOption>();
    for (const option of options) map.set(option.value, option);
    return map;
  }, [options]);

  const currentValue = activeChatVideoMode
    ? modelValue('video', { id: activeChatVideoMode.model, provider: activeChatVideoMode.provider })
    : current
      ? modelValue('chat', current)
      : '';

  const currentIsVisionCapable = modelSupportsImageInput(current);
  const label = (() => {
    if (loading) return '...';
    if (activeChatVideoMode?.label) return activeChatVideoMode.label;
    if (sessionModelUnavailable) return t('model.unavailable') || '...';
    if (current?.name) return current.name;
    if (chatModels.length > 0) return t('model.notSelected') || t('model.unknown') || '...';
    return t('model.noneConfigured') || t('model.unknown') || '...';
  })();

  const handleSelect = useCallback((value: string) => {
    const option = optionByValue.get(value);
    if (!option) return;
    if (option.kind === 'video') {
      const model = videoModels.find((item) => item.id === option.modelId && (item.provider || '') === (option.provider || ''));
      if (!model) return;
      onChatVideoModeChange?.(toChatVideoMode(model));
      return;
    }
    void switchModel(option.modelId, option.provider);
  }, [onChatVideoModeChange, optionByValue, switchModel, videoModels]);

  return (
    <SelectWidget
      className={styles['model-selector']}
      options={options}
      value={currentValue}
      onChange={handleSelect}
      disabled={loading || modelLocked}
      placement="top"
      align="end"
      offset={4}
      popupMinWidth={180}
      popupClassName={selectWidgetStyles.providerInset}
      density="comfortable"
      triggerBare
      onAttemptOpen={() => {
        if (isStreaming) {
          notifySwitchWhileStreaming();
          return false;
        }
        return true;
      }}
      triggerClassName={`${styles['model-pill']}${loading || modelLocked ? ` ${styles['model-pill-disabled']}` : ''}`}
      renderTrigger={(_, open) => (
        <>
          <span>{label}</span>
          {!loading && activeChatVideoMode && (
            <span
              className={`${styles['model-pill-vision-dot']} ${styles.video}`}
              title={videoLabel}
            />
          )}
          {!loading && !activeChatVideoMode && current && (
            <span
              className={`${styles['model-pill-vision-dot']} ${currentIsVisionCapable ? styles.vision : styles['text-only']}`}
              title={currentIsVisionCapable ? capabilityLabel(true) : t('error.modelNoVision')}
            />
          )}
          {!modelLocked && <span className={`${styles['model-arrow']}${open ? ` ${styles.open}` : ''}`}>▾</span>}
        </>
      )}
      renderOption={(option, selected) => {
        const modelOption = option as ModelSelectOption;
        const badgeClass = modelOption.kind === 'video'
          ? styles.video
          : modelOption.visionCapable
            ? styles.vision
            : styles['text-only'];
        return (
          <>
            <span className={styles['model-option-name']}>{option.label}</span>
            {option.description && (
              <span className={`${styles['model-capability-badge']} ${badgeClass}`}>
                {option.description}
              </span>
            )}
            {selected && <span aria-hidden="true">✓</span>}
          </>
        );
      }}
      renderGroupHeader={(provider) => <ProviderGroupHeader provider={provider === '其他' ? '' : provider} />}
    />
  );
}
