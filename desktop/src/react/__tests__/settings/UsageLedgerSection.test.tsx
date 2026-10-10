/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  loadLlmUsageEntries: vi.fn(),
}));

vi.mock('../../settings/tabs/providers/usage-ledger-actions', () => ({
  loadLlmUsageEntries: (options?: unknown) => mocks.loadLlmUsageEntries(options),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'zh-CN' }),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    if (key === 'settings.usage.groupMeta') return `${params?.requests} 次 / ${params?.errors} 错误`;
    if (key === 'settings.usage.cacheShort') return `缓存 ${params?.tokens}`;
    if (key === 'settings.usage.tokensShort') return `${params?.tokens} token`;
    if (key === 'settings.usage.cacheSummary') return `缓存 ${params?.cache} / 未缓存 ${params?.uncached}`;
    return key;
  },
}));

import { UsageLedgerSection } from '../../settings/tabs/providers/UsageLedgerSection';

describe('UsageLedgerSection', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('groups usage by category and model and requests an explicit daily date window', async () => {
    mocks.loadLlmUsageEntries.mockResolvedValue([
      {
        requestId: 'req-1',
        startedAt: '2026-05-25T00:00:00.000Z',
        endedAt: '2026-05-25T00:00:01.000Z',
        durationMs: 1000,
        status: 'ok',
        source: { subsystem: 'session', operation: 'reply' },
        attribution: { kind: 'session', agentId: 'codia', sessionPath: '/s/a.jsonl' },
        model: { provider: 'openai', modelId: 'gpt-5', api: 'openai-responses' },
        usage: {
          input: { totalTokens: 100, uncachedTokens: 40 },
          output: { totalTokens: 25 },
          cache: { readTokens: 60, hit: true },
          totalTokens: 1250,
          costTotal: 0.001,
        },
        error: null,
      },
      {
        requestId: 'req-2',
        startedAt: '2026-05-25T00:00:02.000Z',
        endedAt: '2026-05-25T00:00:03.000Z',
        durationMs: 1000,
        status: 'error',
        source: { subsystem: 'compaction', operation: 'compact' },
        attribution: { kind: 'session', agentId: 'codia', sessionPath: '/s/a.jsonl' },
        model: { provider: 'anthropic', modelId: 'claude', api: 'anthropic-messages' },
        usage: {
          input: { totalTokens: 50 },
          output: { totalTokens: 0 },
          cache: { readTokens: 0, hit: false },
          totalTokens: 1250000,
          costTotal: 0,
        },
        error: { message: 'empty', name: 'AppError' },
      },
    ]);

    render(<UsageLedgerSection />);

    expect(await screen.findByText('用量仅作参考，具体以供应商统计为准。')).toBeInTheDocument();
    expect(mocks.loadLlmUsageEntries).toHaveBeenCalledWith(expect.objectContaining({
      since: expect.any(String),
      until: expect.any(String),
    }));
    expect((await screen.findAllByText('1.3M')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('1.3K')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('模型分布')).length).toBeGreaterThan(0);
    expect(screen.getByText('请求明细')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '按模型' }));

    expect(await screen.findByText('openai / gpt-5')).toBeInTheDocument();
    expect(screen.getByText('anthropic / claude')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '按类别' }));

    expect(await screen.findByText('会话')).toBeInTheDocument();
    expect(screen.getByText('压缩')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '按日期' }));

    expect((await screen.findAllByText('最近 7 天')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '30 天' })).toBeInTheDocument();
  });
});
