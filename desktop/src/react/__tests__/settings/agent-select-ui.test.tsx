/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../../settings/Settings.module.css';
import { useSettingsStore } from '../../settings/store';

vi.mock('../../settings/api', () => ({
  gsapUrl: (path: string) => `http://settings.test${path}`,
  yuanFallbackAvatar: (yuan: string) => `fallback://${yuan}`,
}));

describe('AgentSelect bridge UI', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    useSettingsStore.setState({
      agents: [
        { id: 'agent-a', name: 'Agent 名称 → 火星舰外·铁形修士', yuan: 'gsap', isPrimary: true, hasAvatar: false },
        { id: 'agent-b', name: 'Other Agent', yuan: 'ming', isPrimary: false, hasAvatar: false },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('uses migrated arrow and lets the option button be the only selected container', async () => {
    const { AgentSelect } = await import('../../settings/tabs/bridge/AgentSelect');
    const onChange = vi.fn();

    render(<AgentSelect value="agent-a" onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: /Agent 名称/ });
    expect(trigger.querySelector(`.${styles['bridge-agent-arrow']}`)).toBeTruthy();

    fireEvent.click(trigger);

    await waitFor(() => expect(document.body.querySelector('[data-select-widget-popup]')).toBeTruthy());
    const option = screen.getByRole('option', { name: /Agent 名称/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(option.querySelector(`.${styles['bridge-agent-option']}`)).toBeNull();
    expect(option.querySelector(`.${styles['bridge-agent-check']}`)).toBeTruthy();
    expect(trigger.querySelector(`.${styles['bridge-agent-arrow']}`)).toHaveClass(styles.open);
  });
});
