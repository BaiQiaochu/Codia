/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { AgentToolsSection } from '../AgentToolsSection';

vi.mock('../../../helpers', () => ({
  autoSaveConfig: vi.fn(),
  t: (key: string) => key,
}));

import { autoSaveConfig } from '../../../helpers';

function getRow(container: HTMLElement, toolName: string): HTMLElement | null {
  return container.querySelector(`[data-tool-name="${toolName}"]`);
}

function clickToggle(row: HTMLElement | null) {
  const btn = row?.querySelector('.gsap-toggle') as HTMLElement | null;
  if (btn) fireEvent.click(btn);
}

describe('AgentToolsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders built-in optional toggles while availableTools is not returned yet', () => {
    const { container } = render(
      <AgentToolsSection
        availableTools={undefined}
        disabled={['update_settings', 'dm']}
      />,
    );

    expect(getRow(container, 'browser')).toBeTruthy();
    expect(getRow(container, 'cron')).toBeTruthy();
    expect(getRow(container, 'dm')).toBeTruthy();
    expect(getRow(container, 'install_skill')).toBeTruthy();
    expect(getRow(container, 'office')).toBeTruthy();
    expect(getRow(container, 'update_settings')).toBeTruthy();
    expect(getRow(container, 'workflow')).toBeTruthy();
    expect(getRow(container, 'hermes_agent')).toBeNull();
  });

  it('keeps rapid toggle writes based on the freshest disabled list', () => {
    const { container } = render(
      <AgentToolsSection availableTools={['browser', 'cron']} disabled={[]} />,
    );

    clickToggle(getRow(container, 'browser'));
    clickToggle(getRow(container, 'cron'));

    expect(autoSaveConfig).toHaveBeenNthCalledWith(1, {
      tools: { disabled: ['browser'] },
    });
    expect(autoSaveConfig).toHaveBeenNthCalledWith(2, {
      tools: { disabled: ['browser', 'cron'] },
    });
  });

  it('keeps toggles loading until tools.disabled is loaded', () => {
    const { container } = render(
      <AgentToolsSection availableTools={['browser']} disabled={undefined} />,
    );

    const row = getRow(container, 'browser');
    const toggle = row?.querySelector('.gsap-toggle') as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.getAttribute('aria-busy')).toBe('true');

    clickToggle(row);
    expect(autoSaveConfig).not.toHaveBeenCalled();
  });

  it('does not render removed built-in info tools', () => {
    const { container } = render(
      <AgentToolsSection availableTools={['browser', 'hermes_agent']} disabled={[]} />,
    );

    expect(getRow(container, 'browser')).toBeTruthy();
    expect(getRow(container, 'hermes_agent')).toBeNull();
    expect(container.textContent).not.toContain('settings.agent.tools.builtinBadge');
  });
});
