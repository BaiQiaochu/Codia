import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSettingsStore } from '../store';
import { codiaFetch, codiaUrl, yuanFallbackAvatar } from '../api';
import { t, autoSaveConfig } from '../helpers';
import { SelectWidget, selectWidgetStyles } from '../widgets/SelectWidget';
import { browseAgent, setPrimaryAgent, loadSettingsConfig, loadAgents } from '../actions';
import { readConfigBoolean } from '../resource-state';
import { AgentCardStack } from './agent/AgentCardStack';
import { YuanSelector } from './agent/YuanSelector';
import { MemorySection } from './agent/AgentMemory';
import { AgentToolsSection } from './agent/AgentToolsSection';
import { FormalAgentFeatures } from './agent/FormalAgentFeatures';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';
import { normalizeYuanKey } from '../../utils/yuan';
import { ProviderGroupHeader } from '../../ui';
import {
  type ExpCategory, parseExperience,
  ExperienceBlock, putExperience,
} from './agent/AgentExperience';

const platform = window.platform;

type PromptKind = 'identity' | 'ishiki';

interface PromptDiffLine {
  line: number;
  type: 'changed' | 'added' | 'removed' | 'same';
  current: string;
  template: string;
}

interface PromptTemplateSnapshot {
  kind: PromptKind;
  yuan: string;
  current: string;
  template: string;
  diff: {
    changed: number;
    added: number;
    removed: number;
    lines: PromptDiffLine[];
  };
}

interface PromptTemplatesResponse {
  identity: PromptTemplateSnapshot;
  ishiki: PromptTemplateSnapshot;
  error?: string;
}

function diffLineTypeLabel(type: PromptDiffLine['type']): string {
  if (type === 'added') return '新增';
  if (type === 'removed') return '移除';
  if (type === 'changed') return '变更';
  return '未变';
}

export function AgentTab() {
  const store = useSettingsStore();
  const {
    agents, currentAgentId, settingsAgentId, settingsConfig, currentPins,
    showToast,
    globalModelsConfig,
  } = store;

  const hasUtilityModel = globalModelsConfig
    ? !!(globalModelsConfig.models?.utility && globalModelsConfig.models?.utility_large)
    : undefined;
  const selectedSettingsAgentId = settingsAgentId
    || currentAgentId
    || agents.find(agent => agent.isPrimary)?.id
    || agents[0]?.id
    || null;
  const selectedSettingsAgent = agents.find(agent => agent.id === selectedSettingsAgentId) || null;
  const selectedAgentAvatarUrl = useMemo(() => {
    if (!selectedSettingsAgent) return yuanFallbackAvatar('codia');
    return selectedSettingsAgent.hasAvatar
      ? codiaUrl(`/api/agents/${selectedSettingsAgent.id}/avatar?t=${Date.now()}`, { includeTokenQuery: true })
      : yuanFallbackAvatar(selectedSettingsAgent.yuan);
  }, [selectedSettingsAgent]);

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [ishiki, setIshiki] = useState('');
  const [expCategories, setExpCategories] = useState<ExpCategory[]>([]);
  const [promptTemplateLoading, setPromptTemplateLoading] = useState(false);
  const [promptTemplates, setPromptTemplates] = useState<{ agentId: string; templates: PromptTemplatesResponse } | null>(null);
  const [promptTemplateKind, setPromptTemplateKind] = useState<PromptKind>('identity');
  const [promptTemplateMode, setPromptTemplateMode] = useState<'preview' | 'diff'>('preview');
  const promptTemplateRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPromptTemplates(null);
    setPromptTemplateLoading(false);
    return () => {
      promptTemplateRequestRef.current?.abort();
      promptTemplateRequestRef.current = null;
    };
  }, [selectedSettingsAgentId]);

  useEffect(() => {
    if (settingsConfig) {
      setAgentName(settingsConfig.agent?.name || '');
      setIdentity(settingsConfig._identity || '');
      setIshiki(settingsConfig._ishiki || '');
      setExpCategories(parseExperience(settingsConfig._experience || ''));
    }
  }, [settingsConfig]);

  const currentYuan = normalizeYuanKey(settingsConfig?.agent?.yuan);
  const selectedPromptTemplate = promptTemplates?.agentId === selectedSettingsAgentId
    ? promptTemplates.templates[promptTemplateKind]
    : null;

  const chatRaw = settingsConfig?.models?.chat;
  const currentModel = (() => {
    if (!chatRaw) return '';
    if (typeof chatRaw === 'object' && chatRaw?.id && chatRaw?.provider) {
      return `${chatRaw.provider}/${chatRaw.id}`;
    }
    if (typeof chatRaw === 'object' && chatRaw?.id) return chatRaw.id;
    if (typeof chatRaw === 'string') return chatRaw;
    return '';
  })();

  // Load model options from the same /api/models source used by chat.
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  useEffect(() => {
    codiaFetch('/api/models').then(r => r.json()).then(data => {
      setAvailableModels(data.models || []);
    }).catch(() => {});
  }, [settingsConfig]);
  const modelOptions = useMemo(() => {
    const opts = availableModels.map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: m.name || m.id,
      group: m.provider,
    }));
    if (currentModel && !opts.some((o) => o.value === currentModel)) {
      opts.unshift({ value: currentModel, label: t('settings.agent.modelUnavailable', { model: currentModel }), group: '' });
    }
    return opts;
  }, [availableModels, currentModel]);
  const currentModelUnavailable = !!currentModel && !availableModels.some((m) => `${m.provider}/${m.id}` === currentModel);

  const memoryEnabled = readConfigBoolean(settingsConfig, cfg => cfg.memory?.enabled, true);
  const experienceEnabled = readConfigBoolean(settingsConfig, cfg => cfg.experience?.enabled, false);
  const hasAvailableToolsField = !!settingsConfig && Object.prototype.hasOwnProperty.call(settingsConfig, 'availableTools');
  const availableTools = hasAvailableToolsField ? settingsConfig?.availableTools : undefined;

  const saveAgentName = async () => {
    try {
      const agentId = selectedSettingsAgentId;
      if (!agentId) {
        showToast(t('settings.saveFailed') + ': no agent available', 'error');
        return;
      }
      const currentName = settingsConfig?.agent?.name || '';
      if (!agentName || agentName === currentName) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const res = await codiaFetch(`/api/agents/${agentId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: { name: agentName } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      showToast(t('settings.saved'), 'success');
      if (agentId === currentAgentId) {
        store.set({ agentName });
        platform?.settingsChanged?.('agent-updated', { agentName, agentId });
      }
      await loadSettingsConfig();
      await loadAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  const saveAgent = async () => {
    try {
      const agentId = selectedSettingsAgentId;
      if (!agentId) {
        showToast(t('settings.saveFailed') + ': no agent available', 'error');
        return;
      }
      const agentBase = `/api/agents/${agentId}`;
      const isActive = agentId === currentAgentId;

      const configPartial: Record<string, unknown> = {};
      if (agentName && agentName !== (settingsConfig?.agent?.name || '')) {
        configPartial.agent = { name: agentName };
      }

      const identityChanged = identity !== (settingsConfig?._identity || '');
      const ishikiChanged = ishiki !== (settingsConfig?._ishiki || '');

      if (!Object.keys(configPartial).length && !identityChanged && !ishikiChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const requests: Promise<Response>[] = [];
      if (Object.keys(configPartial).length) {
        requests.push(codiaFetch(`${agentBase}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configPartial),
        }));
      }
      if (identityChanged) {
        requests.push(codiaFetch(`${agentBase}/identity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: identity }),
        }));
      }
      if (ishikiChanged) {
        requests.push(codiaFetch(`${agentBase}/ishiki`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ishiki }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      if (isActive && (configPartial as { agent?: { name: string } })?.agent?.name) {
        store.set({ agentName: (configPartial as { agent: { name: string } }).agent.name });
        platform?.settingsChanged?.('agent-updated', {
          agentName: (configPartial as { agent: { name: string } }).agent.name,
          agentId,
        });
      }
      await loadSettingsConfig();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  const loadPromptTemplates = useCallback(async (mode: 'preview' | 'diff' = promptTemplateMode) => {
    const agentId = selectedSettingsAgentId;
    if (!agentId) return;
    promptTemplateRequestRef.current?.abort();
    const controller = new AbortController();
    promptTemplateRequestRef.current = controller;
    const isCurrentRequest = () => promptTemplateRequestRef.current === controller && !controller.signal.aborted;
    setPromptTemplateMode(mode);
    setPromptTemplateLoading(true);
    try {
      const res = await codiaFetch(`/api/agents/${agentId}/prompt-templates`, { signal: controller.signal });
      const data = await res.json() as PromptTemplatesResponse;
      if (!isCurrentRequest()) return;
      if (data.error) throw new Error(data.error);
      setPromptTemplates({ agentId, templates: data });
    } catch (err: unknown) {
      if (!isCurrentRequest()) return;
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      if (isCurrentRequest()) {
        promptTemplateRequestRef.current = null;
        setPromptTemplateLoading(false);
      }
    }
  }, [promptTemplateMode, selectedSettingsAgentId, showToast]);

  const resetPromptTemplate = useCallback(async () => {
    const agentId = selectedSettingsAgentId;
    if (!agentId) return;
    promptTemplateRequestRef.current?.abort();
    const controller = new AbortController();
    promptTemplateRequestRef.current = controller;
    const isCurrentRequest = () => promptTemplateRequestRef.current === controller && !controller.signal.aborted;
    setPromptTemplateLoading(true);
    try {
      const res = await codiaFetch(`/api/agents/${agentId}/prompt-templates/${promptTemplateKind}/reset`, {
        method: 'POST',
        signal: controller.signal,
      });
      const data = await res.json();
      if (!isCurrentRequest()) return;
      if (data.error) throw new Error(data.error);
      if (promptTemplateKind === 'identity') setIdentity(data.content || '');
      else setIshiki(data.content || '');
      showToast('已恢复默认提示词模板', 'success');
      await loadSettingsConfig();
      if (!isCurrentRequest()) return;
      await loadPromptTemplates(promptTemplateMode);
    } catch (err: unknown) {
      if (!isCurrentRequest()) return;
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      if (isCurrentRequest()) {
        promptTemplateRequestRef.current = null;
        setPromptTemplateLoading(false);
      }
    }
  }, [loadPromptTemplates, promptTemplateKind, promptTemplateMode, selectedSettingsAgentId, showToast]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="agent">
      {/* Agent 卡片堆叠 */}
      <section className={`${styles['settings-section']} ${styles['agent-profile-hero']}`}>
        <h2 className={styles['settings-section-title']}>{t('settings.agent.title')}</h2>
        <AgentCardStack
          agents={agents}
          selectedId={selectedSettingsAgentId}
          currentAgentId={currentAgentId}
          onSelect={(id) => browseAgent(id)}
          onAvatarClick={() => {
            // eslint-disable-next-line no-restricted-syntax -- ephemeral file picker, not part of React tree
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp';
            input.addEventListener('change', () => {
              if (input.files?.[0]) {
                window.dispatchEvent(new CustomEvent('codia-open-cropper', {
                  detail: { role: 'agent', file: input.files[0] },
                }));
              }
            });
            input.click();
          }}
          onSetPrimary={(id) => { void setPrimaryAgent(id); }}
          onDelete={(id) => window.dispatchEvent(new CustomEvent('codia-show-agent-delete', {
            detail: { agentId: id },
          }))}
          onAdd={() => window.dispatchEvent(new Event('codia-show-agent-create'))}
        />
      </section>

      {/* 关于 Ta */}
      <section className={`${styles['settings-section']} ${styles['agent-identity-section']}`}>
        <h2 className={styles['agent-identity-heading']}>{t('settings.agent.title')} · {t('settings.agent.identity')}</h2>
        <div className={styles['agent-identity-card']} data-testid="agent-identity-card">
          <div className={styles['agent-identity-primary']}>
            <img
              className={styles['agent-identity-avatar']}
              src={selectedAgentAvatarUrl}
              alt={selectedSettingsAgent?.name || agentName || t('settings.agent.title')}
              onError={(event) => {
                const image = event.currentTarget;
                image.onerror = null;
                image.src = yuanFallbackAvatar(selectedSettingsAgent?.yuan || 'codia');
              }}
            />
            <div className={styles['agent-identity-controls']}>
              <label className={styles['settings-field-label']} htmlFor="agent-name-input">{t('settings.agent.nameLabel')}</label>
              <input
                id="agent-name-input"
                className={styles['agent-name-input']}
                type="text"
                value={agentName}
                placeholder={t('settings.agent.agentNameHint')}
                onChange={(e) => setAgentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void saveAgentName();
                  }
                }}
              />
              <label className={styles['settings-field-label']}>{t('settings.agent.chatModel')}</label>
              <div className={styles['model-capsule']}>
                <SelectWidget
                  className={styles['model-capsule-select']}
                  triggerClassName={styles['model-capsule-trigger']}
                  options={modelOptions}
                  value={currentModel}
                  onChange={async (value) => {
                    const slashIdx = value.indexOf('/');
                    const provider = slashIdx > 0 ? value.slice(0, slashIdx) : '';
                    const id = slashIdx > 0 ? value.slice(slashIdx + 1) : value;
                    if (!provider || !id) return;
                    const partial: Record<string, unknown> = {
                      models: { chat: { id, provider } },
                    };
                    await autoSaveConfig(partial, { refreshModels: true });
                  }}
                  placeholder={t('settings.api.selectModel')}
                  renderGroupHeader={(provider) => <ProviderGroupHeader provider={provider === '其他' ? '' : provider} />}
                  popupClassName={selectWidgetStyles.providerInset}
                />
              </div>
              {currentModelUnavailable && (
                <span className={styles['settings-field-hint']}>{t('settings.agent.modelUnavailableHint')}</span>
              )}
              <button type="button" className={styles['settings-save-btn-sm']} onClick={() => { void saveAgentName(); }}>
                {t('settings.save')}
              </button>
            </div>
          </div>
          <div className={styles['agent-identity-persona']}>
            <span className={styles['settings-field-label']}>{t('settings.agent.yuanHint')}</span>
            <YuanSelector
              currentYuan={currentYuan}
              onChange={async (key) => {
                const agentId = selectedSettingsAgentId;
                if (!agentId) return;
                try {
                  await codiaFetch(`/api/agents/${agentId}/config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agent: { yuan: key } }),
                  });
                  if (agentId === currentAgentId) store.set({ agentYuan: key });
                  platform?.settingsChanged?.('agent-updated', { agentId, yuan: key });
                  await loadSettingsConfig();
                  await loadAgents();
                } catch (err) {
                  console.error('[yuan] switch failed:', err);
                }
              }}
            />
          </div>
          <div className={styles['agent-identity-details']}>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']} htmlFor="agent-identity-input">{t('settings.agent.identity')}</label>
          <textarea
            id="agent-identity-input"
            className={styles['settings-textarea']}
            rows={3}
            spellCheck={false}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.identityHint')}</span>
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']} htmlFor="agent-ishiki-input">{t('settings.agent.ishiki')}</label>
          <textarea
            id="agent-ishiki-input"
            className={styles['settings-textarea']}
            rows={10}
            spellCheck={false}
            value={ishiki}
            onChange={(e) => setIshiki(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.ishikiHint')}</span>
        </div>
        <div className={styles['settings-field']}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <label className={styles['settings-field-label']} style={{ margin: 0 }}>提示词模板工具</label>
            <select
              className={styles['settings-input']}
              style={{ width: 128 }}
              value={promptTemplateKind}
              onChange={(event) => setPromptTemplateKind(event.target.value as PromptKind)}
            >
              <option value="identity">身份简介</option>
              <option value="ishiki">意识</option>
            </select>
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              disabled={promptTemplateLoading}
              onClick={() => { void loadPromptTemplates('preview'); }}
            >
              模板预览
            </button>
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              disabled={promptTemplateLoading}
              onClick={() => { void loadPromptTemplates('diff'); }}
            >
              差异对比
            </button>
            <button
              type="button"
              className={styles['skill-card-delete']}
              disabled={promptTemplateLoading}
              onClick={() => { void resetPromptTemplate(); }}
            >
              恢复默认
            </button>
          </div>
          {selectedPromptTemplate && (
            <div className={styles['skills-list-block']} style={{ maxHeight: 260, overflow: 'auto' }}>
              <div className={styles['skills-list-item']} style={{ cursor: 'default' }}>
                <div className={styles['skills-list-info']}>
                  <span className={styles['skills-list-name']}>
                    {promptTemplateMode === 'preview' ? '模板预览' : '差异对比'} · {selectedPromptTemplate.yuan}
                  </span>
                  {promptTemplateMode === 'preview' ? (
                    <pre className={styles['settings-code-block']}>{selectedPromptTemplate.template}</pre>
                  ) : (
                    <>
                      <span className={styles['skills-list-desc']}>
                        变更 {selectedPromptTemplate.diff.changed} 行，新增 {selectedPromptTemplate.diff.added} 行，移除 {selectedPromptTemplate.diff.removed} 行
                      </span>
                      {selectedPromptTemplate.diff.lines.length === 0 ? (
                        <span className={styles['skills-list-desc']}>当前内容与默认模板一致。</span>
                      ) : selectedPromptTemplate.diff.lines.map((line) => (
                        <pre key={`${line.line}-${line.type}`} className={styles['settings-code-block']}>
                          {`#${line.line} ${diffLineTypeLabel(line.type)}\n当前: ${line.current}\n模板: ${line.template}`}
                        </pre>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className={`${styles['settings-field']} ${styles['settings-save-row-centered']}`}>
          <button type="button" className={styles['settings-save-btn-sm']} onClick={saveAgent}>
            {t('settings.save')}
          </button>
        </div>
          </div>
        </div>
      </section>

      <MemorySection
        agentId={selectedSettingsAgentId}
        hasUtilityModel={hasUtilityModel === true}
        memoryEnabled={memoryEnabled !== false}
        currentPins={currentPins}
      />
      <FormalAgentFeatures />

      {/* 缁忛獙 */}
      <SettingsSection title={t('settings.experience.title')}>
        <SettingsRow
          label={t('settings.experience.toggleLabel')}
          hint={t('settings.experience.toggleHint')}
          control={<Toggle
            on={experienceEnabled}
            onChange={async (on) => {
              const saved = await autoSaveConfig({ experience: { enabled: on } }, { silent: true });
              if (saved) await loadSettingsConfig();
            }}
          />}
        />
        <div style={{ padding: 'var(--space-sm) var(--space-md)' }}>
          {experienceEnabled === undefined ? null : experienceEnabled === false ? (
            <div className={styles['exp-empty']}>{t('settings.experience.paused')}</div>
          ) : expCategories.length === 0 ? (
            <div className={styles['exp-empty']}>{t('settings.experience.empty')}</div>
          ) : (
            <div className={styles['exp-list']}>
              {expCategories.map((cat) => (
                <ExperienceBlock
                  key={cat.name}
                  category={cat}
                  onSave={(updated) => {
                    const next = expCategories.map(c => c.name === cat.name ? updated : c);
                    setExpCategories(next);
                    putExperience(store, next);
                  }}
                  onDelete={() => {
                    const next = expCategories.filter(c => c.name !== cat.name);
                    setExpCategories(next);
                    putExperience(store, next);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      {/* 默认关闭项与后端 DEFAULT_DISABLED_TOOL_NAMES 保持同步。 */}
      <AgentToolsSection
        availableTools={availableTools}
        disabled={settingsConfig ? settingsConfig.tools?.disabled ?? ["dm", "beautify", "workflow"] : undefined}
      />

    </div>
  );
}
