import { useEffect, useMemo, useRef, useState } from 'react';
import { Collapse, SelectWidget, type SelectOption } from '../../ui';
import { useStore } from '../../stores';
import { resolveAgentDisplayInfo } from '../../utils/agent-display';
import type { CronJob, ModelOption } from './automation-types';
import {
  automationExecutorLabel,
  jobAgentId,
  modelOptionsForJob,
  modelSelectValue,
  modelValueFromSelect,
} from './automation-utils';
import { AutomationHealthPanel } from './AutomationHealthPanel';
import { ScheduleEditor } from './ScheduleEditor';
import { SchedulePolicyEditor, validScheduleTimezone, type MisfirePolicy } from './SchedulePolicyEditor';
import {
  intervalMinutesForApi,
  scheduleDraftFromStored,
  schedulePreviewFromDraft,
  storedScheduleFromDraft,
  type ScheduleDraft,
} from './schedule-draft';
import styles from './AutomationPanel.module.css';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function jobTitle(job: CronJob) {
  return job.label || job.prompt?.slice(0, 40) || job.id;
}

export function AutomationCard({
  job,
  refreshVersion = 0,
  availableModels,
  open,
  onToggleOpen,
  onToggleEnabled,
  onRemove,
  onUpdate,
}: {
  job: CronJob;
  refreshVersion?: number;
  availableModels: ModelOption[];
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => Promise<boolean | void> | void;
}) {
  const t = window.t ?? ((p: string) => p);
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const fallbackAgentName = useStore(s => s.agentName) || '助手';
  const fallbackAgentYuan = useStore(s => s.agentYuan) || 'codia';
  const addToast = useStore(s => s.addToast);
  const [label, setLabel] = useState(jobTitle(job));
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleDraftFromStored(job.type, job.schedule));
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [prompt, setPrompt] = useState(job.prompt || '');
  const [model, setModel] = useState(modelSelectValue(job.model));
  const defaultTimezone = job.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [misfirePolicy, setMisfirePolicy] = useState<MisfirePolicy>(job.misfirePolicy || 'catch-up-once');
  const isAgentSession = !job.executor || job.executor.kind === 'agent_session';
  const executorLabel = automationExecutorLabel(job);
  const modelOptions = useMemo(() => modelOptionsForJob(job, availableModels), [availableModels, job]);
  const agentInfo = resolveAgentDisplayInfo({
    id: jobAgentId(job, currentAgentId),
    agents,
    fallbackAgentName,
    fallbackAgentYuan,
  });

  type EditableField = 'label' | 'schedule' | 'prompt' | 'model' | 'timezone' | 'misfirePolicy';
  const edited = useRef(new Set<EditableField>());
  const revisions = useRef<Record<EditableField, number>>({ label: 0, schedule: 0, prompt: 0, model: 0, timezone: 0, misfirePolicy: 0 });
  const saveInFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const markEdited = (field: EditableField) => { edited.current.add(field); revisions.current[field]++; };

  useEffect(() => {
    // A locally edited field stays owned by its edit revision, including when the
    // user changes it back to the pre-save value while a request is in flight.
    const adopt = <T,>(field: EditableField, value: T, next: T): T => {
      if (!edited.current.has(field)) return next;
      if (!saveInFlight.current && value === next) edited.current.delete(field);
      return value;
    };
    setLabel(value => adopt('label', value, jobTitle(job)));
    if (!edited.current.has('schedule')) setScheduleDraft(scheduleDraftFromStored(job.type, job.schedule));
    setPrompt(value => adopt('prompt', value, job.prompt || ''));
    setModel(value => adopt('model', value, modelSelectValue(job.model)));
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimezone(value => adopt('timezone', value, job.timezone || deviceZone));
    setMisfirePolicy(value => adopt('misfirePolicy', value, job.misfirePolicy || 'catch-up-once'));
  }, [job]);

  const dirty =
    label !== jobTitle(job)
    || scheduleDirty
    || timezone !== defaultTimezone
    || misfirePolicy !== (job.misfirePolicy || 'catch-up-once')
    || prompt !== (job.prompt || '')
    || model !== modelSelectValue(job.model);

  const updateScheduleDraft = (draft: ScheduleDraft) => {
    markEdited('schedule');
    setScheduleDraft(draft);
    setScheduleDirty(true);
  };

  const updateFields = () => {
    const fields: Record<string, unknown> = {};
    if (label !== jobTitle(job)) fields.label = label;
    if (scheduleDirty) {
      const nextSchedule = storedScheduleFromDraft(scheduleDraft);
      fields.type = nextSchedule.type;
      fields.schedule = nextSchedule.type === 'every'
        ? intervalMinutesForApi(scheduleDraft) || nextSchedule.schedule
        : nextSchedule.schedule;
    }
    if (timezone !== defaultTimezone) fields.timezone = timezone;
    if (misfirePolicy !== (job.misfirePolicy || 'catch-up-once')) fields.misfirePolicy = misfirePolicy;
    if (prompt !== (job.prompt || '')) fields.prompt = prompt;
    if (model !== modelSelectValue(job.model)) fields.model = modelValueFromSelect(model);
    return fields;
  };

  const persist = async (fields: Record<string, unknown>) => {
    if (saveInFlight.current || !Object.keys(fields).length) return;
    const submittedRevisions = { ...revisions.current };
    saveInFlight.current = true; setSaving(true);
    try {
      const saved = await onUpdate(job.id, fields);
      if (saved === false) return;
      for (const field of Object.keys(submittedRevisions) as EditableField[]) {
        if (Object.hasOwn(fields, field) && revisions.current[field] === submittedRevisions[field]) {
          edited.current.delete(field);
          if (field === 'schedule') setScheduleDirty(false);
        }
      }
    } finally { saveInFlight.current = false; setSaving(false); }
  };
  const save = async () => {
    if (!validScheduleTimezone(timezone)) return;
    await persist(updateFields());
  };

  const toggleEnabled = async () => {
    if (saveInFlight.current) return;
    if (job.enabled) {
      onToggleEnabled(job.id);
      return;
    }
    if (!validScheduleTimezone(timezone)) return;
    if (isAgentSession && !prompt.trim()) {
      addToast(t('automation.promptRequired'), 'error');
      return;
    }
    await persist({ ...updateFields(), enabled: true });
  };

  return (
    <div className={styles.card}>
      <button type="button" className={styles.row} onClick={onToggleOpen} aria-expanded={open}>
        <span
          className={`codia-toggle${job.enabled ? ' on' : ''}`}
          title={job.enabled ? t('automation.disable') : t('automation.enable')}
          onClick={(e) => {
            e.stopPropagation();
            void toggleEnabled();
          }}
        />
        <span className={styles.rowMain}>
          <span className={styles.title} title={jobTitle(job)}>{jobTitle(job)}</span>
          <span className={styles.subline}>
            <span className={styles.meta}>{schedulePreviewFromDraft(scheduleDraftFromStored(job.type, job.schedule))}</span>
            {job.nextRunAt ? <span className={styles.meta}>{new Date(job.nextRunAt).toLocaleString(undefined, { hour12: false, ...(job.timezone && validScheduleTimezone(job.timezone) ? { timeZone: job.timezone } : {}) })} {job.timezone || '设备时区'}</span> : null}
            <span className={styles.badge}>{executorLabel}</span>
          </span>
        </span>
        <span className={styles.meta}>{job.enabled ? t('common.on') : t('common.off')}</span>
        <Chevron open={open} />
      </button>
      <Collapse open={open}>
        <div className={styles.details}>
          <AutomationHealthPanel job={job} dirty={dirty} refreshVersion={refreshVersion} />
          <div className={styles.fieldGrid}>
            <label className={styles.field}>
              <span>{t('automation.field.label')}</span>
              <input value={label} onChange={e => { markEdited('label'); setLabel(e.target.value); }} />
            </label>
          </div>
          <ScheduleEditor draft={scheduleDraft} onChange={updateScheduleDraft} />
          <SchedulePolicyEditor timezone={timezone} misfirePolicy={misfirePolicy} onTimezoneChange={value => { markEdited('timezone'); setTimezone(value); }} onMisfirePolicyChange={value => { markEdited('misfirePolicy'); setMisfirePolicy(value); }} />
          {isAgentSession ? (
            <label className={styles.field}>
              <span>{t('automation.field.prompt')}</span>
              <textarea
                value={prompt}
                onChange={e => { markEdited('prompt'); setPrompt(e.target.value); }}
                placeholder={t('automation.promptPlaceholder', { agent: agentInfo.displayName })}
              />
            </label>
          ) : null}
          {isAgentSession && availableModels.length > 0 ? (
            <label className={styles.field}>
              <span>{t('rightWorkspace.session.model')}</span>
              <SelectWidget
                options={[
                  { value: '', label: t('automation.defaultModel') } as SelectOption,
                  ...modelOptions.map((option): SelectOption => ({
                    value: `${option.provider}/${option.id}`,
                    label: option.name || option.id,
                  })),
                ]}
                value={model}
                onChange={value => { markEdited('model'); setModel(value); }}
              />
            </label>
          ) : null}
          <div className={styles.actions}>
            <button className={styles.textButton} type="button" disabled={saving || !dirty || !validScheduleTimezone(timezone)} onClick={save}>{t('common.confirm')}</button>
            <button className={`${styles.textButton} ${styles.dangerButton}`} type="button" disabled={saving} onClick={() => onRemove(job.id)}>{t('automation.delete')}</button>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
