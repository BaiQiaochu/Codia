import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { codiaFetch } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import { renderMarkdown } from '../../utils/markdown';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsSection } from '../components/SettingsSection';
import { SelectWidget, type SelectOption } from '../widgets/SelectWidget';
import {
  COMPACTION_MODE_EXPERIMENT_ID,
  COMPACTION_MODES,
  normalizeCompactionMode,
} from '../../../../../shared/compaction-mode.ts';
import styles from '../Settings.module.css';

const CACHE_SNAPSHOT_EXPERIMENT_ID = 'memory.cache_snapshot_reflection';
const EDITABLE_MEMORY_EXPERIMENT_ID = 'memory.editable_facts';
const DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID = 'provider.deepseek_roleplay_reasoning_patch';
const PROACTIVE_SUBAGENT_EXPERIMENT_ID = 'subagent.proactive_delegation';

type CacheSnapshotMode = 'off' | 'shadow' | 'write';
type CompactionMode = 'auto' | 'cache_preserving' | 'pi_compatible';

interface ExperimentDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  owner: string;
  value: unknown;
  status: string;
  risk: string;
  restartPolicy: string;
  valueSchema?: {
    type: string;
    presentation?: {
      type: string;
    };
    options?: Array<{
      value: string;
      labelKey?: string;
      label?: string;
    }>;
  };
}

interface CacheSnapshotObservation {
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
  createdAt?: string;
  sessionPath?: string;
  trigger?: string;
  usage?: {
    model?: string;
    cachedTokens?: number;
    missTokens?: number;
    latencyMs?: number;
  };
  summaryPreview?: string;
  memoryMdPreview?: string;
}

function normalizeCacheSnapshotMode(value: unknown): CacheSnapshotMode {
  return value === 'shadow' || value === 'write' ? value : 'off';
}

function normalizeUiCompactionMode(value: unknown): CompactionMode {
  return normalizeCompactionMode(value) as CompactionMode;
}

function formatObservationTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function experimentHint(experiment: ExperimentDefinition) {
  const parts = [
    t(`settings.experiments.status.${experiment.status}`),
    t(`settings.experiments.risk.${experiment.risk}`),
    t(`settings.experiments.restart.${experiment.restartPolicy}`),
  ].filter(Boolean);
  return parts.join(' | ');
}

function SwitchButton({
  checked,
  disabled,
  label,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`codia-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

function ObservationPanel({
  observation,
  onClear,
}: {
  observation: CacheSnapshotObservation | null;
  onClear: () => void;
}) {
  return (
    <div className={styles['experiments-observation']}>
      {!observation ? (
        <div className={styles['experiments-empty']}>
          {t('settings.experiments.cacheSnapshot.emptyPreview')}
        </div>
      ) : (
        <>
          <div className={styles['experiments-observation-meta']}>
            {formatObservationTime(observation.createdAt) && (
              <span>{formatObservationTime(observation.createdAt)}</span>
            )}
            {observation.trigger && <span>{observation.trigger}</span>}
            {observation.status && <span>{observation.status}</span>}
            {observation.usage?.model && <span>{observation.usage.model}</span>}
            {typeof observation.usage?.cachedTokens === 'number' && (
              <span>cache {observation.usage.cachedTokens}/{observation.usage.missTokens || 0}</span>
            )}
            {typeof observation.usage?.latencyMs === 'number' && (
              <span>{observation.usage.latencyMs}ms</span>
            )}
          </div>

          {observation.reason && (
            <div className={styles['experiments-observation-error']}>{observation.reason}</div>
          )}

          {observation.summaryPreview?.trim() && (
            <div className={styles['experiments-preview-block']}>
              <h3>{t('settings.experiments.cacheSnapshot.summaryTitle')}</h3>
              <pre>{observation.summaryPreview}</pre>
            </div>
          )}

          {observation.memoryMdPreview?.trim() ? (
            <div className={styles['experiments-preview-block']}>
              <h3>{t('settings.experiments.cacheSnapshot.previewTitle')}</h3>
              <div
                className={`${styles['compiled-memory-md']} md-content`}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(observation.memoryMdPreview) }}
              />
            </div>
          ) : (
            <div className={styles['experiments-empty']}>
              {observation.reason || t('settings.experiments.cacheSnapshot.emptyPreview')}
            </div>
          )}

          <button type="button" className={styles['experiments-clear-btn']} onClick={onClear}>
            {t('settings.experiments.cacheSnapshot.clearObservation')}
          </button>
        </>
      )}
    </div>
  );
}

function CacheSnapshotExperiment({
  experiment,
  onValueChange,
}: {
  experiment: ExperimentDefinition;
  onValueChange: (id: string, value: CacheSnapshotMode) => Promise<void>;
}) {
  const primaryAgentId = useSettingsStore(s => (
    s.agents.find((agent) => agent.isPrimary)?.id || null
  ));
  const [observation, setObservation] = useState<CacheSnapshotObservation | null>(null);
  const [observationLoaded, setObservationLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const mode = normalizeCacheSnapshotMode(experiment.value);
  const enabled = mode !== 'off';
  const observeOnly = mode === 'shadow';

  const observationUrl = useMemo(() => {
    if (!primaryAgentId) return null;
    return `/api/experiments/memory/cache-snapshot-reflection/observation?agentId=${encodeURIComponent(primaryAgentId)}`;
  }, [primaryAgentId]);

  const loadObservation = useCallback(async () => {
    if (!observationUrl) return;
    const res = await codiaFetch(observationUrl);
    const data = await res.json();
    setObservation(data.observation || null);
    setObservationLoaded(true);
  }, [observationUrl]);

  useEffect(() => {
    loadObservation().catch(() => {
      setObservation(null);
      setObservationLoaded(true);
    });
  }, [loadObservation]);

  const setMode = async (next: CacheSnapshotMode) => {
    setSaving(true);
    try {
      await onValueChange(experiment.id, next);
      if (next === 'shadow') {
        loadObservation().catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  };

  const clearObservation = async () => {
    if (!observationUrl) return;
    await codiaFetch(observationUrl, { method: 'DELETE' });
    setObservation(null);
  };

  const hint = [
    experimentHint(experiment),
    mode === 'write' ? t('settings.experiments.cacheSnapshot.writeWarning') : '',
  ].filter(Boolean).join(' | ');

  const showObservation = mode === 'shadow' || (observationLoaded && !!observation);

  return (
    <>
      <SettingsRow
        label={t(experiment.titleKey)}
        hint={hint}
        hintVariant={mode === 'write' ? 'warn' : 'default'}
        control={(
          <SwitchButton
            checked={enabled}
            disabled={saving}
            label={t(experiment.titleKey)}
            onClick={() => setMode(enabled ? 'off' : 'shadow')}
          />
        )}
      />
      <SettingsRow
        label={t('settings.experiments.cacheSnapshot.observeOnly')}
        hint={t('settings.experiments.cacheSnapshot.observationNote')}
        control={(
          <SwitchButton
            checked={observeOnly}
            disabled={!enabled || saving}
            label={t('settings.experiments.cacheSnapshot.observeOnly')}
            onClick={() => setMode(observeOnly ? 'write' : 'shadow')}
          />
        )}
      />
      {showObservation && (
        <ObservationPanel observation={observation} onClear={clearObservation} />
      )}
    </>
  );
}

function compactionModeOptions(experiment: ExperimentDefinition): SelectOption[] {
  const fromSchema = experiment.valueSchema?.options
    ?.filter((option) => typeof option?.value === 'string')
    .map((option) => ({
      value: option.value,
      label: option.labelKey ? t(option.labelKey) : (option.label || option.value),
    })) || [];
  if (fromSchema.length > 0) return fromSchema;
  return [
    { value: COMPACTION_MODES.AUTO, label: t('settings.experiments.compaction.auto') },
    { value: COMPACTION_MODES.CACHE_PRESERVING, label: t('settings.experiments.compaction.cachePreserving') },
    { value: COMPACTION_MODES.PI_COMPATIBLE, label: t('settings.experiments.compaction.piCompatible') },
  ];
}

function CompactionModeExperiment({
  experiment,
  onValueChange,
}: {
  experiment: ExperimentDefinition;
  onValueChange: (id: string, value: CompactionMode) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const mode = normalizeUiCompactionMode(experiment.value);
  const options = useMemo(() => compactionModeOptions(experiment), [experiment]);

  const setMode = async (next: string) => {
    const normalized = normalizeUiCompactionMode(next);
    setSaving(true);
    try {
      await onValueChange(experiment.id, normalized);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      label={t(experiment.titleKey)}
      hint={t(experiment.descriptionKey)}
      control={(
        <SelectWidget
          options={options}
          value={mode}
          onChange={setMode}
          disabled={saving}
        />
      )}
    />
  );
}

function BooleanExperiment({
  experiment,
  onValueChange,
}: {
  experiment: ExperimentDefinition;
  onValueChange: (id: string, value: boolean) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const enabled = experiment.value === true;
  const hint = [
    t(experiment.descriptionKey),
    experimentHint(experiment),
  ].filter(Boolean).join(' | ');

  const setEnabled = async (next: boolean) => {
    setSaving(true);
    try {
      await onValueChange(experiment.id, next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      label={t(experiment.titleKey)}
      hint={hint}
      control={(
        <SwitchButton
          checked={enabled}
          disabled={saving}
          label={t(experiment.titleKey)}
          onClick={() => setEnabled(!enabled)}
        />
      )}
    />
  );
}

export function ExperimentsTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const [experiments, setExperiments] = useState<ExperimentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const sessionExperiments = experiments.filter((experiment) => experiment.owner === 'session');
  const providerExperiments = experiments.filter((experiment) => (
    experiment.owner === 'provider'
    && experiment.id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID
  ));
  const memoryExperiments = experiments.filter((experiment) => experiment.owner === 'memory');
  const cacheSnapshotExperiment = memoryExperiments.find((experiment) => (
    experiment.id === CACHE_SNAPSHOT_EXPERIMENT_ID
  ));

  useEffect(() => {
    codiaFetch('/api/experiments')
      .then((res) => res.json())
      .then((data) => setExperiments(Array.isArray(data.experiments) ? data.experiments : []))
      .catch(() => setExperiments([]))
      .finally(() => setLoading(false));
  }, []);

  const updateExperimentValue = async (id: string, value: unknown) => {
    const res = await codiaFetch(`/api/experiments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const nextValue = data.value ?? value;
    setExperiments((items) => items.map((item) => (
      item.id === id ? { ...item, value: nextValue } : item
    )));
    showToast(t('settings.autoSaved'), 'success');
  };

  return (
    <>
      {!loading && sessionExperiments.length > 0 && (
        <SettingsSection
          title={t('settings.experiments.compactionTitle')}
          description={t('settings.experiments.compactionSectionDescription')}
        >
          {sessionExperiments.map((experiment) => (
            experiment.id === COMPACTION_MODE_EXPERIMENT_ID ? (
              <CompactionModeExperiment
                key={experiment.id}
                experiment={experiment}
                onValueChange={updateExperimentValue}
              />
            ) : null
          ))}
        </SettingsSection>
      )}
      {!loading && sessionExperiments.some((experiment) => experiment.id === PROACTIVE_SUBAGENT_EXPERIMENT_ID) && (
        <SettingsSection
          title={t('settings.experiments.subagentTitle')}
          description={t('settings.experiments.subagentSectionDescription')}
        >
          {sessionExperiments.map((experiment) => (
            experiment.id === PROACTIVE_SUBAGENT_EXPERIMENT_ID ? (
              <BooleanExperiment
                key={experiment.id}
                experiment={experiment}
                onValueChange={updateExperimentValue}
              />
            ) : null
          ))}
        </SettingsSection>
      )}
      {!loading && providerExperiments.length > 0 && (
        <SettingsSection
          title={t('settings.experiments.modelPersonaTitle')}
          description={t('settings.experiments.modelPersonaDescription')}
        >
          {providerExperiments.map((experiment) => (
            <BooleanExperiment
              key={experiment.id}
              experiment={experiment}
              onValueChange={updateExperimentValue}
            />
          ))}
        </SettingsSection>
      )}
      <SettingsSection
        title={t('settings.experiments.memoryTitle')}
        description={t(cacheSnapshotExperiment?.descriptionKey || 'settings.experiments.memorySectionDescription')}
      >
        {loading ? (
          <div className={styles['experiments-empty']}>{t('common.loading')}</div>
        ) : memoryExperiments.length === 0 ? (
          <div className={styles['experiments-empty']}>{t('settings.experiments.empty')}</div>
        ) : (
          memoryExperiments.map((experiment) => (
            experiment.id === CACHE_SNAPSHOT_EXPERIMENT_ID ? (
              <CacheSnapshotExperiment
                key={experiment.id}
                experiment={experiment}
                onValueChange={updateExperimentValue}
              />
            ) : experiment.id === EDITABLE_MEMORY_EXPERIMENT_ID ? (
              <BooleanExperiment
                key={experiment.id}
                experiment={experiment}
                onValueChange={updateExperimentValue}
              />
            ) : null
          ))
        )}
      </SettingsSection>
    </>
  );
}
