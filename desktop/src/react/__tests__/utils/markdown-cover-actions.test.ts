/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { regenerateMarkdownCoverWithPrompt } from '../../utils/markdown-cover-actions';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  codiaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: mocks.codiaFetch,
}));

describe('markdown cover actions', () => {
  const originalPrompt = window.prompt;

  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.codiaFetch.mockReset();
    mocks.codiaFetch.mockResolvedValue(new Response(JSON.stringify({
      systemCover: { available: true },
      agentGenerate: { available: true, enabled: true, executorAgentId: 'agent-1' },
      available: true,
      enabled: true,
      agentId: 'agent-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    mocks.codiaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      systemCover: { available: true },
      agentGenerate: { available: true, enabled: true, executorAgentId: 'agent-1' },
      available: true,
      enabled: true,
      agentId: 'agent-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    window.prompt = vi.fn(() => {
      throw new Error('prompt() is not supported');
    });
    useStore.setState({ currentAgentId: 'agent-1' } as never);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.prompt = originalPrompt;
    useStore.setState({ currentAgentId: null } as never);
  });

  it('collects custom cover guidance with an in-app dialog when native prompt is unavailable', async () => {
    const action = regenerateMarkdownCoverWithPrompt('/vault/day.md');

    const dialog = document.querySelector('.markdown-cover-prompt-dialog') as HTMLElement | null;
    expect(dialog).toBeInstanceOf(HTMLElement);
    expect(window.prompt).not.toHaveBeenCalled();

    const textarea = dialog!.querySelector('textarea') as HTMLTextAreaElement | null;
    const submit = [...dialog!.querySelectorAll('button')]
      .find(button => button.textContent === '生成') as HTMLButtonElement | undefined;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(submit).toBeInstanceOf(HTMLButtonElement);

    textarea!.value = '更像晨光里的矿山规划图';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    submit!.click();

    await action;

    expect(mocks.codiaFetch).toHaveBeenCalledWith('/api/desk/beautify/status');
    expect(mocks.codiaFetch).not.toHaveBeenCalledWith('/api/desk/beautify/status?executorAgentId=agent-1');
    expect(mocks.codiaFetch).toHaveBeenCalledWith('/api/desk/beautify/cover', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        filePath: '/vault/day.md',
        themeTone: 'light',
        executorAgentId: 'agent-1',
        userGuidance: '更像晨光里的矿山规划图',
      }),
    }));
  });

  it('does not submit custom cover generation when the selected agent has beautify disabled', async () => {
    const notices: Array<{ text: string; type: string }> = [];
    window.addEventListener('codia-inline-notice', ((event: CustomEvent) => {
      notices.push(event.detail);
    }) as EventListener);
    mocks.codiaFetch.mockReset();
    mocks.codiaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      systemCover: { available: true },
      agentGenerate: {
        available: true,
        enabled: false,
        executorAgentId: 'agent-1',
        disabledReason: 'beautify-disabled',
        message: 'beautify tool is disabled for this agent',
      },
      available: true,
      enabled: false,
      agentId: 'agent-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const action = regenerateMarkdownCoverWithPrompt('/vault/day.md');
    const dialog = document.querySelector('.markdown-cover-prompt-dialog') as HTMLElement;
    const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '更像晨光里的矿山规划图';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (dialog.querySelector('.markdown-cover-prompt-primary') as HTMLButtonElement).click();

    await action;

    expect(mocks.codiaFetch).toHaveBeenCalledWith('/api/desk/beautify/status');
    expect(mocks.codiaFetch).not.toHaveBeenCalledWith('/api/desk/beautify/status?executorAgentId=agent-1');
    expect(mocks.codiaFetch).not.toHaveBeenCalledWith('/api/desk/beautify/cover', expect.anything());
    expect(notices).toContainEqual({
      text: 'Cover 生成失败：beautify tool is disabled for this agent',
      type: 'error',
    });
  });
});
