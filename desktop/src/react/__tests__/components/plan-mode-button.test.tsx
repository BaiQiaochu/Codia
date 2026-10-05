// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanModeButton } from '../../components/input/PlanModeButton';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: vi.fn(),
}));

const LABELS: Record<string, string> = {
  'input.autoMode': 'Auto mode',
  'input.operateMode': 'Operate mode',
  'input.askMode': 'Ask mode',
  'input.readOnlyMode': 'Read-only mode',
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
    vi.mocked(gsapFetch).mockResolvedValueOnce(jsonResponse({ permissionMode: 'auto' }));
    useStore.setState({ pendingNewSession: true } as never);
    const onChange = vi.fn();

    render(<PlanModeButton mode="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask mode' }));
    expect(gsapFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Auto mode' }));

    await waitFor(() => {
      expect(gsapFetch).toHaveBeenCalledWith('/api/preferences/session-permission-default', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ permissionMode: 'auto' }),
      }));
    });
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('targets the active session when changing an existing conversation permission mode', async () => {
    vi.mocked(gsapFetch).mockResolvedValueOnce(jsonResponse({ mode: 'operate' }));
    useStore.setState({
      currentSessionPath: '/tmp/gsap-session.jsonl',
      pendingNewSession: false,
    } as never);
    const onChange = vi.fn();

    render(<PlanModeButton mode="read_only" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read-only mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Operate mode' }));

    await waitFor(() => {
      expect(gsapFetch).toHaveBeenCalledWith('/api/session-permission-mode', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          mode: 'operate',
          pendingNewSession: false,
          sessionPath: '/tmp/gsap-session.jsonl',
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
    expect(readOnlyIcon).not.toBeNull();
    expect(readOnlyIcon?.getAttribute('viewBox')).toBe('0 0 32 32');
  });

  it('renders an icon for every open permission menu option', () => {
    render(<PlanModeButton mode="ask" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Ask mode' }));

    const dropdown = document.body.querySelector('[class*="plan-mode-dropdown"]');
    expect(dropdown?.querySelector('svg[data-permission-mode="auto"]')).not.toBeNull();
    expect(dropdown?.querySelector('svg[data-permission-mode="operate"]')).not.toBeNull();
    expect(dropdown?.querySelector('svg[data-permission-mode="ask"]')).not.toBeNull();
    expect(dropdown?.querySelector('svg[data-permission-mode="read_only"]')).not.toBeNull();
  });

  it('scales the read-only book icon visually without changing its layout slot', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const readOnlyIconBlock = css.match(/svg\[data-permission-mode="read_only"\]\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(readOnlyIconBlock).toMatch(/transform\s*:\s*scale\(0\.8\)/);
    expect(readOnlyIconBlock).toMatch(/transform-origin\s*:\s*center/);
  });

  it('keeps ask neutral, trigger modes colored, and menu mode colors text-only', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const askBlock = css.match(/\.plan-mode-ask\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const autoBlock = css.match(/\.plan-mode-auto\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const operateBlock = css.match(/\.plan-mode-operate\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const readOnlyBlock = css.match(/\.plan-mode-read_only\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionAutoBlock = css.match(/\.plan-mode-option-auto\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionOperateBlock = css.match(/\.plan-mode-option-operate\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionAskBlock = css.match(/\.plan-mode-option-ask\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionReadOnlyBlock = css.match(/\.plan-mode-option-read_only\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionActiveBlock = css.match(/\.plan-mode-option\.active\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const dropdownBlock = css.match(/\.thinking-dropdown\.plan-mode-dropdown\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const optionBlock = css.match(/\.plan-mode-option\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(askBlock).not.toMatch(/color\s*:|background\s*:|border-color\s*:/);
    expect(autoBlock).toContain('var(--permission-auto');
    expect(autoBlock).not.toContain('var(--danger');
    expect(autoBlock).not.toContain('var(--accent');
    expect(operateBlock).toContain('var(--danger');
    expect(readOnlyBlock).toContain('var(--accent');
    expect(readOnlyBlock).not.toContain('var(--danger');
    expect(optionAutoBlock).toContain('var(--permission-auto');
    expect(optionOperateBlock).toContain('var(--danger');
    expect(optionAskBlock).toContain('var(--text-muted');
    expect(optionReadOnlyBlock).toContain('var(--accent');
    expect(optionAutoBlock).not.toMatch(/background\s*:/);
    expect(optionOperateBlock).not.toMatch(/background\s*:/);
    expect(optionAskBlock).not.toMatch(/background\s*:/);
    expect(optionReadOnlyBlock).not.toMatch(/background\s*:/);
    expect(optionActiveBlock).toMatch(/font-weight\s*:\s*400/);
    expect(dropdownBlock).toContain('width: max-content');
    expect(dropdownBlock).toMatch(/min-width\s*:\s*0/);
    expect(optionBlock).toContain('white-space: nowrap');
  });
});
