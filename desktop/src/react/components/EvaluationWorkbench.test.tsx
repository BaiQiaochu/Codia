// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { EvaluationWorkbench } from './EvaluationWorkbench';
afterEach(cleanup);
const data = (status: string) => ({ schemaVersion: 1, kind: 'deterministic-regression', traceId: 't', cases: [{ id: 'case-1', category: 'recovery', status, score: status === 'passed' ? 1 : 0, maximumScore: 1 }] });
describe('evaluation workbench', () => {
  it('compares local reports without uploading or running tasks', async () => {
    render(<EvaluationWorkbench />);
    fireEvent.change(screen.getByLabelText('基线报告'), { target: { files: [{ size: 100, text: async () => JSON.stringify(data('passed')) }] } });
    await screen.findByText(/通过 1 \/ 1/);
    fireEvent.change(screen.getByLabelText('候选报告'), { target: { files: [{ size: 100, text: async () => JSON.stringify(data('failed')) }] } });
    expect(await screen.findByText('回归 1；改善 0')).toBeTruthy();
  });
  it('rejects unsupported input instead of presenting fake scores', async () => {
    render(<EvaluationWorkbench />);
    fireEvent.change(screen.getByLabelText('基线报告'), { target: { files: [{ size: 100, text: async () => '{}' }] } });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

const modelData = (executionMode = 'mock') => ({
  schemaVersion: 1, kind: 'model-task-evaluation', executionMode, traceId: 'model-eval-1',
  dataset: { id: 'bounded-tasks', version: '1.0', fingerprint: 'a'.repeat(64) },
  versions: { provider: 'fixture', model: 'small-model', prompt: 'v1', template: 'v1', strategy: 'single-agent' },
  cases: Array.from({ length: 30 }, (_, index) => ({ id: `task-${index}`, traceId: `trace-${index}`, category: 'success', status: 'passed', attempted: true, score: 1, maximumScore: 1, durationMs: 4,
    cost: { amount: null, currency: 'USD', source: 'unknown' }, criteria: [{ id: 'answer', passed: true, points: 1, maximumPoints: 1 }] })),
});
const upload = (label: string, value: unknown) => fireEvent.change(screen.getByLabelText(label), { target: { files: [{ size: 100, text: async () => JSON.stringify(value) }] } });

describe('model-task evaluation workbench', () => {
  it('labels mock provenance and unknown cost while showing versioned task metrics', async () => {
    render(<EvaluationWorkbench />);
    upload('基线报告', modelData());
    expect(await screen.findByText(/模拟参考答案回放，仅验证评测工具/)).toBeTruthy();
    expect(screen.getByText(/费用未知：30 个已调用任务/)).toBeTruthy();
    expect(screen.getByText(/数据集：bounded-tasks \/ 1.0/)).toBeTruthy();
    expect(screen.getByText(/成功任务平均费用：未知／未测量/)).toBeTruthy();
  });
  it('refuses mock/live and cross-kind comparisons instead of claiming model improvements', async () => {
    render(<EvaluationWorkbench />);
    upload('基线报告', modelData());
    await screen.findByText(/模拟参考答案回放/);
    upload('候选报告', modelData('live'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('模拟回放不能与真实模型混比'));
    expect(screen.queryByText(/回归 0；改善 0/)).toBeNull();
    upload('候选报告', data('passed'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
  it('shows quality and duration differences only for comparable task reports', async () => {
    render(<EvaluationWorkbench />);
    upload('基线报告', modelData());
    await screen.findByText(/模拟参考答案回放/);
    upload('候选报告', modelData());
    expect(await screen.findByText(/候选减基线：成功率 0 个百分点/)).toBeTruthy();
    expect(screen.getByText('回归 0；改善 0')).toBeTruthy();
  });
  it('keeps the newer file when an earlier file finishes loading later', async () => {
    render(<EvaluationWorkbench />);
    let resolveOld: (text: string) => void;
    fireEvent.change(screen.getByLabelText('基线报告'), { target: { files: [{ size: 100, text: () => new Promise<string>(resolve => { resolveOld = resolve; }) }] } });
    upload('基线报告', modelData());
    await screen.findByText(/模拟参考答案回放/);
    resolveOld!(JSON.stringify(data('failed')));
    await Promise.resolve();
    expect(screen.getByText(/模拟参考答案回放/)).toBeTruthy();
    expect(screen.queryByText('通过 0 / 1；得分 0 / 1')).toBeNull();
  });
});
