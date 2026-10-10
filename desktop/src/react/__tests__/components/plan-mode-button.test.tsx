// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanModeButton } from '../../components/input/PlanModeButton';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: vi.fn(),
}));

const LABELS: Record<string, string> = {
  'input.autoMode': 'Approve for me',
  'input.autoModeDescription': 'Ask only for risky operations',
  'input.operateMode': 'Full access',
  'input.operateModeDescription': 'Access the internet and any file',
  'input.askMode': 'Request approval',
  'input.askModeDescription': 'Always ask before external changes',
  'input.readOnlyMode': 'Request approval',
  'input.accessMode': 'Access mode',
  'input.accessModeLocked': 'Access mode locked',
};

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => LABELS[key] || key }),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('PlanModeButton', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: null,
      pendingNewSession: false,
    } as never);
  });

  it('stores pending new-session permission changes in the default preference route', async () => {
    vi.mocked(codiaFetch).mockResolvedValueOnce(jsonResponse({ permissionMode: 'auto' }));
    useStore.setState({ pendingNewSession: true } as never);
    const onChange = vi.fn();

    render(<PlanModeButton mode="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    expect(codiaFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Approve for me/ }));

    await waitFor(() => {
      expect(codiaFetch).toHaveBeenCalledWith('/api/preferences/session-permission-default', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ permissionMode: 'auto' }),
      }));
    });
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('targets the active session when changing an existing conversation permission mode', async () => {
    vi.mocked(codiaFetch).mockResolvedValueOnce(jsonResponse({ mode: 'operate' }));
    useStore.setState({
      currentSessionPath: '/tmp/codia-session.jsonl',
      pendingNewSession: false,
    } as never);
    const onChange = vi.fn();

    render(<PlanModeButton mode="read_only" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    fireEvent.click(screen.getByRole('button', { name: /Full access/ }));

    await waitFor(() => {
      expect(codiaFetch).toHaveBeenCalledWith('/api/session-permission-mode', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          mode: 'operate',
          pendingNewSession: false,
          sessionPath: '/tmp/codia-session.jsonl',
        }),
      }));
    });
    expect(onChange).toHaveBeenCalledWith('operate');
  });

  it('uses a distinct trigger icon for each permission mode', () => {
    const { container, rerender } = render(<PlanModeButton mode="auto" onChange={vi.fn()} />);
    expect(container.querySelector('svg[data-permission-mode="auto"]')).not.toBeNull();

    rerender(<PlanModeButton mode="ask" onChange={vi.fn()} />);
    expect(container.querySelector('svg[data-permission-mode="ask"]')).not.toBeNull();

    rerender(<PlanModeButton mode="operate" onChange={vi.fn()} />);
    expect(container.querySelector('svg[data-permission-mode="operate"]')).not.toBeNull();

    rerender(<PlanModeButton mode="read_only" onChange={vi.fn()} />);
    const readOnlyIcon = container.querySelector('svg[data-permission-mode="read_only"]');
    expect(readOnlyIcon).toBeNull();
    expect(container.querySelector('svg[data-permission-mode="ask"]')).not.toBeNull();
  });

  it('renders an icon for every open permission menu option', () => {
    render(<PlanModeButton mode="ask" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));

    const dropdown = document.body.querySelector('[class*="plan-mode-dropdown"]');
    expect(dropdown?.querySelector('svg[data-permission-mode="auto"]')).not.toBeNull();
    expect(dropdown?.querySelector('svg[data-permission-mode="operate"]')).not.toBeNull();
    expect(dropdown?.querySelector('svg[data-permission-mode="ask"]')).not.toBeNull();
    expect(dropdown?.querySelector('svg[data-permission-mode="read_only"]')).toBeNull();
  });

  it('renders the three approval choices with descriptions', () => {
    render(<PlanModeButton mode="ask" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    expect(css).toContain('.plan-mode-option-copy');
    expect(css).toContain('.plan-mode-option-check');
    expect(screen.getByText('Always ask before external changes')).not.toBeNull();
    expect(screen.getByText('Ask only for risky operations')).not.toBeNull();
    expect(screen.getByText('Access the internet and any file')).not.toBeNull();
  });

  it('keeps ask neutral, trigger modes colored, and menu mode colors text-only', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const askBlock = css.match(/\.plan-mode-ask\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const autoBlock = css.match(/\.plan-mode-auto\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const operateBlock = css.match(/\.plan-mode-operate\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionAutoBlock = css.match(/\.plan-mode-option-auto\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionOperateBlock = css.match(/\.plan-mode-option-operate\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionAskBlock = css.match(/\.plan-mode-option-ask\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionActiveBlock = css.match(/\.plan-mode-option\.active\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const dropdownBlock = css.match(/\.thinking-dropdown\.plan-mode-dropdown\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionBlock = css.match(/\.plan-mode-option\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(askBlock).not.toMatch(/color\s*:|background\s*:|border-color\s*:/);
    expect(autoBlock).toContain('var(--permission-auto');
    expect(autoBlock).not.toContain('var(--danger');
    expect(autoBlock).not.toContain('var(--accent');
    expect(operateBlock).toContain('#f97316');
    expect(optionAutoBlock).toContain('var(--permission-auto');
    expect(optionOperateBlock).toContain('#f97316');
    expect(optionAskBlock).toContain('var(--text-muted');
    expect(optionAutoBlock).not.toMatch(/background\s*:/);
    expect(optionOperateBlock).not.toMatch(/background\s*:/);
    expect(optionAskBlock).not.toMatch(/background\s*:/);
    expect(optionActiveBlock).toMatch(/font-weight\s*:\s*400/);
    expect(dropdownBlock).toContain('width: min(420px');
    expect(optionBlock).toContain('white-space: normal');
  });
});
