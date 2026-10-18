// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SchedulePolicyEditor, validScheduleTimezone } from './SchedulePolicyEditor';
import { AutomationCard } from './AutomationCard';

vi.mock('../../stores', () => ({ useStore: (selector: (value: unknown) => unknown) => selector({ agents: [], currentAgentId: 'a', agentName: 'Codia', agentYuan: 'codia', addToast: vi.fn() }) }));
vi.mock('../../ui', () => ({ Collapse: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, SelectWidget: () => null }));
vi.mock('./ScheduleEditor', () => ({ ScheduleEditor: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('schedule policy controls', () => {
  it('exposes timezone and misfire edits and explains local availability and DST', () => {
    const zone = vi.fn();
    const misfire = vi.fn();
    render(<SchedulePolicyEditor timezone="Asia/Shanghai" misfirePolicy="catch-up-once" onTimezoneChange={zone} onMisfirePolicyChange={misfire} />);
    fireEvent.change(screen.getByLabelText('任务时区（IANA）'), { target: { value: 'America/New_York' } });
    fireEvent.change(screen.getByLabelText('漏跑处理'), { target: { value: 'skip' } });
    expect(zone).toHaveBeenCalledWith('America/New_York');
    expect(misfire).toHaveBeenCalledWith('skip');
    expect(screen.getByText(/回拨时重复的分钟各执行一次/)).toBeTruthy();
    expect(screen.getByText(/电脑休眠或应用退出时不保证执行/)).toBeTruthy();
  });

  it('rejects malformed zones and fixed offsets with an accessible error', () => {
    expect(validScheduleTimezone('+08:00')).toBe(false);
    render(<SchedulePolicyEditor timezone="Invalid/Zone" misfirePolicy="skip" onTimezoneChange={vi.fn()} onMisfirePolicyChange={vi.fn()} />);
    expect(screen.getByLabelText('任务时区（IANA）').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('sends changed timezone and misfire fields through the existing save action', () => {
    window.t = (key: string) => key;
    const update = vi.fn();
    render(<AutomationCard job={{ id: 'job', enabled: true, type: 'cron', schedule: '0 9 * * *', timezone: 'Asia/Shanghai', prompt: 'read', misfirePolicy: 'catch-up-once' }} availableModels={[]} open onToggleOpen={vi.fn()} onToggleEnabled={vi.fn()} onRemove={vi.fn()} onUpdate={update} />);
    fireEvent.change(screen.getByLabelText('任务时区（IANA）'), { target: { value: 'America/New_York' } });
    fireEvent.change(screen.getByLabelText('漏跑处理'), { target: { value: 'skip' } });
    fireEvent.click(screen.getByText('common.confirm'));
    expect(update).toHaveBeenCalledWith('job', { timezone: 'America/New_York', misfirePolicy: 'skip' });
    fireEvent.change(screen.getByLabelText('任务时区（IANA）'), { target: { value: 'Invalid/Zone' } });
    expect((screen.getByText('common.confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});
