import fp from '../FloatingPanels.module.css';
import type { CreateJobDraft, ScheduleType } from './cron-utils';

function panelT(key: string, vars?: Record<string, string | number>) {
  return (window.t ?? ((p: string) => p))(key, vars);
}

interface Props {
  draft: CreateJobDraft;
  availableModels: string[];
  previewText: string;
  creating: boolean;
  onChange: (updater: (prev: CreateJobDraft) => CreateJobDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function AutomationCreateForm({
  draft,
  availableModels,
  previewText,
  creating,
  onChange,
  onCancel,
  onSubmit,
}: Props) {
  return (
    <div className={fp.automationCreateCard}>
      <div className={fp.automationCreateGrid}>
        <label className={fp.automationCreateField}>
          <span className={fp.automationCreateLabel}>{panelT('automation.createLabel')}</span>
          <input
            className={fp.automationCreateInput}
            type="text"
            value={draft.label}
            onChange={(e) => onChange((prev) => ({ ...prev, label: e.target.value }))}
          />
        </label>

        <label className={fp.automationCreateField}>
          <span className={fp.automationCreateLabel}>{panelT('automation.createScheduleType')}</span>
          <select
            className={fp.automationCreateInput}
            value={draft.scheduleType}
            onChange={(e) => onChange((prev) => ({ ...prev, scheduleType: e.target.value as ScheduleType }))}
          >
            <option value="at">{panelT('cron.typeAt')}</option>
            <option value="every">{panelT('cron.typeEvery')}</option>
            <option value="cron">{panelT('cron.typeCron')}</option>
          </select>
        </label>

        {draft.scheduleType === 'at' && (
          <label className={fp.automationCreateField}>
            <span className={fp.automationCreateLabel}>{panelT('automation.createSchedule')}</span>
            <input
              className={fp.automationCreateInput}
              type="datetime-local"
              value={draft.atTime}
              onChange={(e) => onChange((prev) => ({ ...prev, atTime: e.target.value }))}
            />
            <span className={fp.automationCreateHint}>{panelT('automation.createAtHint')}</span>
          </label>
        )}

        {draft.scheduleType === 'every' && (
          <label className={fp.automationCreateField}>
            <span className={fp.automationCreateLabel}>{panelT('automation.createSchedule')}</span>
            <input
              className={fp.automationCreateInput}
              type="number"
              min="1"
              value={draft.everyMinutes}
              onChange={(e) => onChange((prev) => ({ ...prev, everyMinutes: e.target.value }))}
            />
            <span className={fp.automationCreateHint}>{panelT('automation.createEveryHint')}</span>
          </label>
        )}

        {draft.scheduleType === 'cron' && (
          <label className={fp.automationCreateField}>
            <span className={fp.automationCreateLabel}>{panelT('automation.createSchedule')}</span>
            <input
              className={fp.automationCreateInput}
              type="text"
              value={draft.cronExpr}
              onChange={(e) => onChange((prev) => ({ ...prev, cronExpr: e.target.value }))}
            />
            <span className={fp.automationCreateHint}>{panelT('automation.createCronHint')}</span>
          </label>
        )}

        <label className={fp.automationCreateField}>
          <span className={fp.automationCreateLabel}>{panelT('automation.defaultModel')}</span>
          <select
            className={fp.automationCreateInput}
            value={draft.model}
            onChange={(e) => onChange((prev) => ({ ...prev, model: e.target.value }))}
          >
            <option value="">{panelT('automation.defaultModel')}</option>
            {availableModels.map((modelId) => (
              <option key={modelId} value={modelId}>{modelId}</option>
            ))}
          </select>
        </label>
      </div>

      <label className={fp.automationCreateField}>
        <span className={fp.automationCreateLabel}>{panelT('automation.createPrompt')}</span>
        <textarea
          className={fp.automationCreateTextarea}
          rows={4}
          value={draft.prompt}
          onChange={(e) => onChange((prev) => ({ ...prev, prompt: e.target.value }))}
        />
      </label>

      <div className={fp.automationCreatePreview}>
        <span>{panelT('automation.nextRun')}</span>
        <strong>{previewText || '-'}</strong>
      </div>

      <div className={fp.automationCreateActions}>
        <button type="button" className={fp.autoItemBtn} onClick={onCancel}>
          {panelT('automation.createCancel')}
        </button>
        <button type="button" className={fp.floatingPanelActionBtn} onClick={onSubmit} disabled={creating}>
          {creating ? '...' : panelT('automation.createSubmit')}
        </button>
      </div>
    </div>
  );
}
