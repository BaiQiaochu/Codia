// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ExperienceItem, RecordedMemoryRun } from '../memory-api';
vi.mock('./MemoryRunPicker', () => ({
  MemoryRunPicker: ({ onSelect }: { onSelect: (run: RecordedMemoryRun) => void }) => <button onClick={() => onSelect({ runId: 'activity:run-1', environmentProvenance: 'recorded', environment: { projectId: 'workspace:/alpha' } } as RecordedMemoryRun)}>选择合成运行</button>,
  MemoryProjectSelect: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} />,
}));
import { ExperienceCard } from './MemoryGovernanceCards';
afterEach(cleanup);
const entry: ExperienceItem = { id: 'exp-1', revision: 3, contentRevision: 2, state: 'candidate', category: 'Build', content: 'Old content', taskType: 'build', goal: '', preconditions: [], actions: [], verificationMethod: 'tests', risks: [], rollback: '', sourceRefs: [], parentMemoryIds: [], applicability: { scope: 'project', projectId: 'workspace:/alpha', platform: 'linux' }, createdAt: '', updatedAt: '', lastVerifiedAt: null, withdrawalReason: null, evidence: [], stats: { retrieved: 0, injected: 0, attempted: 0, verifiedSuccess: 0, verifiedFailure: 0, unknown: 0 } };
const callbacks = () => ({ agentId: 'alpha', busy: false, onReview: vi.fn().mockResolvedValue(false), onAttempt: vi.fn().mockResolvedValue(false), onTransition: vi.fn().mockResolvedValue(false), onRevise: vi.fn().mockResolvedValue(false), onOpenRun: vi.fn().mockReturnValue(false) });
const checkbox = () => screen.getByLabelText(/我已检查上述运行与证据/) as HTMLInputElement;
const save = () => screen.getByText('保存核实结果') as HTMLButtonElement;
function approveExternal() {
  fireEvent.click(screen.getByText('记录核实结果'));
  fireEvent.change(screen.getByLabelText('证据来源'), { target: { value: 'external_manual' } });
  fireEvent.change(screen.getByLabelText('运行标识'), { target: { value: 'actual-run' } });
  fireEvent.change(screen.getByLabelText('证据引用'), { target: { value: 'actual-report' } });
  fireEvent.change(screen.getByLabelText('结果摘要'), { target: { value: 'Checked old content' } });
  fireEvent.click(checkbox());
  expect(save().disabled).toBe(false);
}
it.each(['revision', 'identity'] as const)('rejects stale approval at new %s commit before passive effects', kind => {
  const props = callbacks();
  let observed: { checked: boolean; disabled: boolean } | undefined;
  function Harness({ changed }: { changed: boolean }) {
    useLayoutEffect(() => {
      if (changed) { observed = { checked: checkbox().checked, disabled: save().disabled }; save().click(); }
    }, [changed]);
    return <ExperienceCard {...props} entry={changed ? { ...entry, ...(kind === 'revision' ? { revision: 4 } : { id: 'different-entry' }) } : entry} />;
  }
  const view = render(<Harness changed={false} />);
  approveExternal(); view.rerender(<Harness changed />);
  expect(observed).toEqual({ checked: false, disabled: true });
  expect(props.onReview).not.toHaveBeenCalled();
  expect((screen.getByLabelText('结果摘要') as HTMLTextAreaElement).value).toBe('Checked old content');
});
it.each([
  ['运行标识', 'other-run'], ['证据引用', 'other-report'], ['运行平台', 'darwin'], ['应用版本', '2.0.0'],
  ['运行频道', 'new-channel'], ['运行依赖版本', 'example=2.0.0'], ['运行项目', 'workspace:/other'],
  ['核实结果', 'success'], ['结果摘要', 'New result'],
])('requires new approval after changing external evidence field %s', (label, value) => {
  const props = callbacks(); render(<ExperienceCard {...props} entry={entry} />); approveExternal();
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(checkbox().checked).toBe(false); expect(save().disabled).toBe(true);
  fireEvent.click(save()); expect(props.onReview).not.toHaveBeenCalled();
  fireEvent.click(checkbox()); fireEvent.click(save());
  expect(props.onReview).toHaveBeenCalledTimes(1);
});
it.each(['content changed', 'identity changed', 'feedback revision only'] as const)('binds late adoption acknowledgement to content identity: %s', async kind => {
  let finish!: (ok: boolean) => void;
  const props = callbacks(); props.onAttempt.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve; }));
  const view = render(<ExperienceCard {...props} entry={entry} />);
  fireEvent.click(screen.getByText('记录核实结果')); fireEvent.click(screen.getByText('选择合成运行'));
  fireEvent.click(screen.getByText('本次实际采用了这条经验'));
  expect(props.onAttempt).toHaveBeenCalledWith(entry, 'activity:run-1');
  const next = { ...entry, revision: 4, ...(kind === 'content changed' ? { contentRevision: 3, content: 'New content' } : kind === 'identity changed' ? { id: 'different-entry' } : {}) };
  view.rerender(<ExperienceCard {...props} entry={next} />);
  await act(async () => { finish(true); });
  const adopt = screen.getByText('本次实际采用了这条经验') as HTMLButtonElement;
  expect(adopt.disabled).toBe(kind === 'feedback revision only');
  if (kind !== 'feedback revision only') { fireEvent.click(adopt); expect(props.onAttempt).toHaveBeenLastCalledWith(next, 'activity:run-1'); }
});
