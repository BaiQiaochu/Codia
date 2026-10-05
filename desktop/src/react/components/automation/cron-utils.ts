import { cronToHuman } from '../../utils/format';

export type ScheduleType = 'at' | 'every' | 'cron';

export interface CreateJobDraft {
  label: string;
  prompt: string;
  scheduleType: ScheduleType;
  atTime: string;
  everyMinutes: string;
  cronExpr: string;
  model: string;
}

export function toDateTimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createEmptyDraft(): CreateJobDraft {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000);
  nextHour.setSeconds(0, 0);
  return {
    label: '',
    prompt: '',
    scheduleType: 'every',
    atTime: toDateTimeLocalValue(nextHour),
    everyMinutes: '60',
    cronExpr: '0 9 * * *',
    model: '',
  };
}

export function formatNextRun(nextRunAt?: string | null) {
  if (!nextRunAt) return '';
  const date = new Date(nextRunAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function schedulePreview(draft: CreateJobDraft) {
  switch (draft.scheduleType) {
    case 'at':
      return formatNextRun(draft.atTime);
    case 'every': {
      const minutes = Math.max(1, Number.parseInt(draft.everyMinutes, 10) || 1);
      return cronToHuman(minutes * 60_000);
    }
    case 'cron':
      return cronToHuman(draft.cronExpr);
    default:
      return '';
  }
}
