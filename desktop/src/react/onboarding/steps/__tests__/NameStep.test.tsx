/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameStep } from '../NameStep';
import type { gsapFetch } from '../../onboarding-actions';

describe('NameStep', () => {
  beforeEach(() => {
    vi.stubGlobal('t', (key: string) => {
      const map: Record<string, string> = {
        'onboarding.name.title': '名字与记忆',
        'onboarding.name.subtitle': '先让我知道该怎么称呼你，也给这个智能体一个名字。',
        'onboarding.name.userLabel': '我该怎么称呼你？',
        'onboarding.name.placeholder': '你的名字',
        'onboarding.name.agentLabel': '这个智能体叫什么？',
        'onboarding.name.agentPlaceholder': '小助',
        'onboarding.name.memoryTitle': '记忆系统',
        'onboarding.name.memoryHint': '开启后整理聊天内容。',
        'onboarding.name.back': '上一步',
        'onboarding.name.next': '下一步',
      };
      return map[key] ?? key;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders user name, agent name, and memory controls', () => {
    render(<NameStep preview gsapFetch={vi.fn<gsapFetch>()} goToStep={vi.fn()} showError={vi.fn()} />);

    expect(screen.getByPlaceholderText('你的名字')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('小助')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '记忆系统' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves identity and memory settings before moving to provider setup', async () => {
    const gsapFetchMock = vi.fn<gsapFetch>(async () => new Response(JSON.stringify({ ok: true })));
    const goToStep = vi.fn();

    render(<NameStep preview={false} gsapFetch={gsapFetchMock} goToStep={goToStep} showError={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('你的名字'), { target: { value: '测试用户' } });
    fireEvent.change(screen.getByPlaceholderText('小助'), { target: { value: '项目助手' } });
    fireEvent.click(screen.getByRole('switch', { name: '记忆系统' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => {
      expect(goToStep).toHaveBeenCalledWith(2);
    });
    const body = JSON.parse(String(gsapFetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      user: { name: '测试用户' },
      agent: { name: '项目助手' },
      memory: { enabled: false },
    });
  });
});
