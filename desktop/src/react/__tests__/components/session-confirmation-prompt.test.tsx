// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfirmationBlock } from '../../stores/chat-types';
import { SessionConfirmationPrompt } from '../../components/input/SessionConfirmationPrompt';

const gsapFetchMock = vi.fn();

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

function makeToolApprovalBlock(): SessionConfirmationBlock {
  return {
    type: 'session_confirmation',
    confirmId: 'confirm-tool-1',
    kind: 'tool_action_approval',
    surface: 'input',
    status: 'pending',
    title: '允许 G-SAP 执行这次操作',
    body: 'This action may change local or external state.',
    subject: {
      label: 'write',
      detail: 'path: E:\\workspace\\SKILL.md',
    },
    severity: 'elevated',
    actions: {
      confirmLabel: '同意',
      rejectLabel: '拒绝',
    },
  };
}

describe('SessionConfirmationPrompt', () => {
  beforeEach(() => {
    gsapFetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes('/api/session-permission-mode') ? { ok: true, mode: 'operate' } : { ok: true }),
    }));
    Object.assign(window, {
      t: (key: string) => ({
        'common.approve': '同意',
        'common.reject': '拒绝',
        'common.approved': 'Approved',
        'common.rejected': 'Rejected',
        'input.confirmMoreOptions': '更多确认选项',
        'input.noAskThisConversation': '本对话不再询问',
        'input.accessModeLocked': '当前无法更改权限模式',
      } as Record<string, string>)[key] || key,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders tool approval as a split consent button with a no-ask option', async () => {
    render(<SessionConfirmationPrompt block={makeToolApprovalBlock()} />);

    expect(screen.getByText('允许 G-SAP 执行这次操作')).toBeTruthy();
    expect(screen.getByText('write')).toBeTruthy();
    expect(screen.getByText('path: E:\\workspace\\SKILL.md')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '更多确认选项' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '本对话不再询问' }));

    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith('/api/session-permission-mode', expect.objectContaining({
        method: 'POST',
      }));
      expect(gsapFetchMock).toHaveBeenCalledWith('/api/confirm/confirm-tool-1', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('localizes the computer app approval subject label', () => {
    Object.assign(window, {
      t: (key: string) => ({
        'common.approve': 'Approve',
        'common.reject': 'Reject',
        'input.computerAppSubject': '\u7535\u8111\u5e94\u7528',
      } as Record<string, string>)[key] || key,
    });

    render(<SessionConfirmationPrompt block={{
      type: 'session_confirmation',
      confirmId: 'confirm-app-1',
      kind: 'computer_app_approval',
      surface: 'input',
      status: 'pending',
      title: 'Approve app',
      body: '',
      subject: {
        label: 'Code.exe',
        detail: 'Visual Studio Code',
      },
      actions: {},
    }} />);

    expect(screen.queryByText('computer app')).toBeNull();
    expect(screen.getByText('\u7535\u8111\u5e94\u7528')).toBeTruthy();
  });
});
