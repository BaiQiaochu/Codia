import { useId } from 'react';
import styles from './AutomationPanel.module.css';

export type MisfirePolicy = 'skip' | 'catch-up-once';

export function validScheduleTimezone(value: string) {
  if (!value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
}

export function SchedulePolicyEditor({ timezone, misfirePolicy, onTimezoneChange, onMisfirePolicyChange }: {
  timezone: string;
  misfirePolicy: MisfirePolicy;
  onTimezoneChange: (timezone: string) => void;
  onMisfirePolicyChange: (policy: MisfirePolicy) => void;
}) {
  const helpId = useId();
  const errorId = useId();
  const invalid = !validScheduleTimezone(timezone);
  return (
    <fieldset className={styles.policySettings}>
      <legend>调度可靠性</legend>
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span>任务时区（IANA）</span>
          <input value={timezone} onChange={e => onTimezoneChange(e.target.value)}
            placeholder="Asia/Shanghai" aria-invalid={invalid} aria-describedby={invalid ? errorId : helpId} />
        </label>
        <label className={styles.field}>
          <span>漏跑处理</span>
          <select value={misfirePolicy} onChange={e => onMisfirePolicyChange(e.target.value as MisfirePolicy)}>
            <option value="catch-up-once">恢复后补跑一次</option>
            <option value="skip">跳过漏跑周期</option>
          </select>
        </label>
      </div>
      {invalid ? <p id={errorId} role="alert">请输入有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。</p> : null}
      <p id={helpId} className={styles.policyHint}>时区用于每日、每周、每月和 cron 计划；单次时间使用当前设备时区，间隔任务按经过时间计算。夏令时跳过不存在的分钟；回拨时重复的分钟各执行一次。</p>
      <p className={styles.policyHint}>本地调度默认并发上限为 4，每个任务同时只运行一次；超过上限等待下次扫描。漏跑宽限为 60 秒。电脑休眠或应用退出时不保证执行，恢复后按所选策略处理。</p>
    </fieldset>
  );
}
