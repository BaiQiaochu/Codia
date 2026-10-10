// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsPanel } from '../../components/SkillsPanel';
import { useStore } from '../../stores';

const fetchMock = vi.fn();

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: (...args: unknown[]) => fetchMock(...args),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

async function flushMicrotasks(ticks = 3) {
  await act(async () => {
    for (let index = 0; index < ticks; index += 1) await Promise.resolve();
  });
}

describe('SkillsPanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    window.t = ((key: string, vars?: Record<string, string | number>) => {
      if (key === 'settings.skills.installSuccess') return `installed ${vars?.name || ''}`;
      return key;
    }) as typeof window.t;
    window.platform = {
      getFilePath: vi.fn(() => 'E:/skills/new-skill.skill'),
      openSkillViewer: vi.fn(),
      showInFinder: vi.fn(),
      notifyMainWindow: vi.fn(),
    } as unknown as typeof window.platform;
    useStore.setState({
      activePanel: 'skills',
      currentAgentId: 'agent-a',
      agentName: 'Primary Agent',
      agentYuan: 'primary',
      agents: [
        { id: 'agent-a', name: 'Primary Agent', yuan: 'primary', isPrimary: true },
        { id: 'agent-b', name: 'Research Agent', yuan: 'research', isPrimary: false },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { platform?: unknown }).platform;
    delete (window as unknown as { t?: unknown }).t;
  });

  it('installs dropped skills for the selected agent, returns to all skills, and highlights the installed row', async () => {
    let installed = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/install')) {
        expect(url).toContain('agentId=agent-b');
        expect(JSON.parse(String(opts?.body || '{}'))).toMatchObject({ path: 'E:/skills/new-skill.skill' });
        installed = true;
        return Promise.resolve(jsonResponse({ ok: true, skill: { name: 'new-skill' } }));
      }
      if (url.includes('/api/skills/bundles')) return Promise.resolve(jsonResponse({ bundles: [] }));
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({
          skills: installed
            ? [
                { name: 'old-skill', enabled: true, source: 'user', description: 'Existing' },
                { name: 'new-skill', enabled: true, source: 'user', description: 'Fresh' },
              ]
            : [
                { name: 'old-skill', enabled: true, source: 'user', description: 'Existing' },
              ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('tab', { name: 'Research Agent' }));

    const file = new File(['skill'], 'new-skill.skill');
    fireEvent.drop(screen.getByTestId('skills-panel-drop-surface'), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(fetchMock.mock.calls.some(call =>
      typeof call[0] === 'string' && call[0].includes('/api/skills/install?agentId=agent-b'),
    )).toBe(true));
    await flushMicrotasks(6);

    expect(screen.getByRole('tab', { name: 'skills.panel.allTab' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('skill-row-new-skill')).toHaveAttribute('data-highlighted', 'true');
  });

  it('installs dropped skills for the current agent from all skills by default', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/install')) {
        expect(url).toContain('agentId=agent-a');
        expect(JSON.parse(String(opts?.body || '{}'))).toMatchObject({ path: 'E:/skills/new-skill.skill' });
        return Promise.resolve(jsonResponse({ ok: true, skill: { name: 'current-agent-skill' } }));
      }
      if (url.includes('/api/skills/bundles')) return Promise.resolve(jsonResponse({ bundles: [] }));
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'current-agent-skill', enabled: true, source: 'user', description: 'Fresh' },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    const file = new File(['skill'], 'new-skill.skill');
    fireEvent.drop(screen.getByTestId('skills-panel-drop-surface'), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(fetchMock.mock.calls.some(call =>
      typeof call[0] === 'string' && call[0].includes('/api/skills/install?agentId=agent-a'),
    )).toBe(true));
    await flushMicrotasks(6);

    expect(screen.getByRole('tab', { name: 'skills.panel.allTab' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('skill-row-current-agent-skill')).toHaveAttribute('data-highlighted', 'true');
  });

  it('creates skill bundles from the all skills page for the current agent view', async () => {
    let created = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/skills/bundles') && opts?.method === 'POST') {
        expect(url).toContain('agentId=agent-a');
        expect(JSON.parse(String(opts.body || '{}'))).toMatchObject({
          name: 'Research',
          skillNames: [],
        });
        created = true;
        return Promise.resolve(jsonResponse({ ok: true, bundle: { id: 'research', name: 'Research', skillNames: [] } }));
      }
      if (url.includes('/api/skills/bundles')) return Promise.resolve(jsonResponse({ bundles: [] }));
      if (url.includes('/api/skills?agentId=')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: true, source: 'user', description: 'Read' },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('button', { name: '新建技能包' }));
    fireEvent.change(screen.getByLabelText('技能包名称'), {
      target: { value: 'Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(created).toBe(true));
  });

  it('toggles a skill from an agent tab with the same agent skills API as settings', async () => {
    let toggled = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/agents/agent-b/skills/reader')) {
        expect(opts?.method).toBe('PATCH');
        expect(JSON.parse(String(opts?.body || '{}'))).toEqual({ enabled: true });
        toggled = true;
        return Promise.resolve(jsonResponse({ ok: true, enabled: ['reader'], changed: ['reader'] }));
      }
      if (url.includes('/api/skills/bundles')) return Promise.resolve(jsonResponse({ bundles: [] }));
      if (url.includes('/api/skills?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: toggled, source: 'user', description: 'Read' },
          ],
        }));
      }
      if (url.includes('/api/skills?agentId=')) return Promise.resolve(jsonResponse({ skills: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('tab', { name: 'Research Agent' }));
    const row = await screen.findByTestId('skill-row-reader');

    fireEvent.click(within(row).getByRole('button'));

    await waitFor(() => expect(toggled).toBe(true));
  });

  it('keeps skill rows mounted while refreshing after a skill toggle', async () => {
    let agentBLoads = 0;
    let reloadStarted = false;
    let resolveReload: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/agents/agent-b/skills/reader')) {
        expect(opts?.method).toBe('PATCH');
        return Promise.resolve(jsonResponse({ ok: true, enabled: ['reader'], changed: ['reader'] }));
      }
      if (url.includes('/api/skills/bundles')) return Promise.resolve(jsonResponse({ bundles: [] }));
      if (url.includes('/api/skills?agentId=agent-b')) {
        agentBLoads += 1;
        if (agentBLoads > 1) {
          reloadStarted = true;
          return new Promise<Response>((resolve) => {
            resolveReload = resolve;
          });
        }
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: false, source: 'user', description: 'Read' },
          ],
        }));
      }
      if (url.includes('/api/skills?agentId=')) return Promise.resolve(jsonResponse({ skills: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('tab', { name: 'Research Agent' }));
    const row = await screen.findByTestId('skill-row-reader');

    fireEvent.click(within(row).getByRole('button'));

    await waitFor(() => expect(reloadStarted).toBe(true));
    expect(screen.queryByText('status.loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-row-reader')).toBeInTheDocument();

    resolveReload?.(jsonResponse({
      skills: [
        { name: 'reader', enabled: true, source: 'user', description: 'Read' },
      ],
    }));
    await flushMicrotasks(4);
  });

  it('toggles a skill bundle from an agent tab with the same bundle API as settings', async () => {
    let bundleToggled = false;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('/api/agents/agent-b/skill-bundles/writing-bundle')) {
        expect(opts?.method).toBe('PATCH');
        expect(JSON.parse(String(opts?.body || '{}'))).toEqual({ enabled: true });
        bundleToggled = true;
        return Promise.resolve(jsonResponse({ ok: true, enabled: ['reader'], changed: ['reader'] }));
      }
      if (url.includes('/api/skills/bundles?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({
          bundles: [
            { id: 'writing-bundle', name: 'Writing Bundle', skillNames: ['reader'] },
          ],
        }));
      }
      if (url.includes('/api/skills/bundles')) return Promise.resolve(jsonResponse({ bundles: [] }));
      if (url.includes('/api/skills?agentId=agent-b')) {
        return Promise.resolve(jsonResponse({
          skills: [
            { name: 'reader', enabled: bundleToggled, source: 'user', description: 'Read' },
          ],
        }));
      }
      if (url.includes('/api/skills?agentId=')) return Promise.resolve(jsonResponse({ skills: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillsPanel />);
    await flushMicrotasks(4);

    fireEvent.click(screen.getByRole('tab', { name: 'Research Agent' }));
    await screen.findByText('Writing Bundle');
    expect(screen.getByText('reader')).toBeTruthy();

    fireEvent.click(screen.getByTestId('skill-bundle-toggle-writing-bundle'));

    await waitFor(() => expect(bundleToggled).toBe(true));
    expect(screen.getByText('reader')).toBeTruthy();
    expect(screen.queryByText('status.loading')).toBeNull();
  });
});
