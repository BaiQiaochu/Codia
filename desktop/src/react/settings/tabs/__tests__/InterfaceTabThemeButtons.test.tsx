/**
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfaceTab } from '../InterfaceTab';
import { ThemeStep } from '../../../onboarding/steps/ThemeStep';
import { useSettingsStore } from '../../store';
import registry from '../../../../shared/theme-registry';

function themeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[data-theme]'));
}

type ThemeButtonTestWindow = Window & {
  __CODIA_PWA__?: { serverUrl: (path: string) => string };
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

const WORKBENCH_THEME = registry.LEGACY_THEME_ALIASES['sage-workbench'];

describe('fixed Codia theme settings', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ settingsConfig: {}, activeTab: 'interface' });
    window.t = (key: string) => key;
    window.i18n = { locale: 'zh-CN' } as Window['i18n'];
    window.setTheme = vi.fn();
    window.applyThemeOverrides = vi.fn();
    window.resetThemeOverrides = vi.fn();
    window.setPaperTexture = vi.fn();
    window.platform = { settingsChanged: vi.fn() } as unknown as Window['platform'];
    URL.createObjectURL = vi.fn(() => 'blob:theme-preset');
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true, editor: { markdown: { bodyFontSize: 17 } } }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('does not render theme selection cards in settings', () => {
    const { container } = render(
      <form>
        <InterfaceTab />
      </form>,
    );

    const buttons = themeButtons(container);
    expect(buttons).toEqual([]);
    expect(registry.getThemeIds()).toEqual([registry.DEFAULT_THEME]);
  });

  it('does not submit surrounding forms from onboarding theme cards', () => {
    const { container } = render(
      <form>
        <ThemeStep goToStep={vi.fn()} />
      </form>,
    );

    const buttons = themeButtons(container);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.getAttribute('type')).toBe('button');
    }
  });

  it('normalizes legacy saved themes to Codia without exposing a switch', () => {
    (window as ThemeButtonTestWindow).__CODIA_PWA__ = { serverUrl: (path: string) => path };
    localStorage.setItem(registry.STORAGE_KEY, 'sage-workbench');
    const { container } = render(<InterfaceTab />);

    const workbenchButton = container.querySelector(`button[data-theme="${WORKBENCH_THEME}"]`) as HTMLButtonElement | null;
    expect(workbenchButton).toBeNull();
    expect(registry.migrateSavedTheme(localStorage.getItem(registry.STORAGE_KEY))).toBe(registry.DEFAULT_THEME);
    expect(window.setTheme).not.toHaveBeenCalled();
    delete (window as ThemeButtonTestWindow).__CODIA_PWA__;
  });

  it('saves editor typography through the global config route', async () => {
    (window as ThemeButtonTestWindow).__CODIA_PWA__ = { serverUrl: (path: string) => path };
    useSettingsStore.setState({
      currentAgentId: 'codia',
      settingsConfig: { editor: { markdown: { bodyFontSize: 15 } } },
    });

    const { container } = render(<InterfaceTab />);
    const bodySizeInput = Array.from(container.querySelectorAll('input[type="number"]'))
      .find((input) => (input as HTMLInputElement).value === '15') as HTMLInputElement | undefined;

    expect(bodySizeInput).toBeTruthy();
    fireEvent.change(bodySizeInput!, { target: { value: '17' } });

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([url, init]) => (
        url === '/api/config' && (init as RequestInit | undefined)?.method === 'PUT'
      ))).toBe(true);
    });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => String(url).includes('/api/agents/codia/config'))).toBe(false);
    delete (window as ThemeButtonTestWindow).__CODIA_PWA__;
  });

  it('exposes only the Codia theme during onboarding', () => {
    const settings = render(<InterfaceTab />);
    expect(settings.container.querySelector('button[data-theme]')).toBeNull();
    cleanup();

    const onboarding = render(<ThemeStep goToStep={vi.fn()} />);
    const onboardingThemes = themeButtons(onboarding.container).map(button => button.dataset.theme);
    expect(onboardingThemes).toEqual([registry.DEFAULT_THEME]);
  });

  it('keeps newly added Chinese theme option names localized', () => {
    const zh = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'desktop/src/locales/zh.json'), 'utf8'));
    const appearance = zh.settings.appearance;

    expect(appearance.studioLight).not.toBe('Studio Light');
    expect(appearance.nocturne).not.toBe('Nocturne');
    expect(appearance.workbench).not.toBe('Workbench');
  });

  it('keeps theme action buttons on generic settings styles instead of search verification styles', () => {
    const { container } = render(<InterfaceTab />);

    const nonThemeActionButtons = Array.from(
      container.querySelectorAll('button:not([data-theme]):not([role="switch"])'),
    );

    expect(nonThemeActionButtons.length).toBeGreaterThan(0);
    for (const button of nonThemeActionButtons) {
      expect(button.className).not.toContain('search-verify-btn');
    }
  });

  it('sources theme preview colors from the registry instead of a local palette', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../InterfaceTab.tsx'), 'utf8');

    expect(source).not.toContain('THEME_PREVIEW_PALETTES');
    expect(source).toContain('registry.THEMES');
    expect(source).toContain('.preview');
  });

  it('does not expose theme override controls from the interface tab', () => {
    const { queryByLabelText, queryByRole } = render(<InterfaceTab />);

    expect(queryByLabelText('主题强调色')).toBeNull();
    expect(queryByLabelText('圆角')).toBeNull();
    expect(queryByRole('button', { name: '重置主题微调' })).toBeNull();
  });

  it('does not expose import or export for retired theme overrides', () => {
    const { container, queryByLabelText, queryByRole } = render(<InterfaceTab />);

    expect(queryByLabelText('导入主题预设')).toBeNull();
    expect(queryByRole('button', { name: '导出主题预设' })).toBeNull();
    expect(container.querySelector('input[type="file"][accept="application/json,.json"]')).toBeNull();
  });

  it('hides legacy decorative controls while preserving stored compatibility preferences', () => {
    localStorage.setItem(registry.STORAGE_KEY, 'terminal-soft');
    localStorage.setItem('codia-paper-texture', '1');

    const { container } = render(<InterfaceTab />);

    expect(localStorage.getItem('codia-paper-texture')).toBe('1');
    expect(container.textContent).not.toContain('Paper texture is unavailable');
    expect(container.textContent).not.toContain('settings.appearance.paperTexture');
    expect(container.textContent).not.toContain('settings.appearance.leavesOverlay');
  });

  it('does not render the retired theme comparator', () => {
    localStorage.setItem(registry.STORAGE_KEY, WORKBENCH_THEME);
    const { container } = render(<InterfaceTab />);

    const comparator = container.querySelector('[data-testid="theme-preview-comparator"]');
    expect(comparator).toBeNull();
  });
});
