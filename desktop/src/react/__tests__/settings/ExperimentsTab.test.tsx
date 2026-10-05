// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../settings/store';

const gsapFetchMock = vi.fn();

function response(body: unknown): Response {
  return { json: async () => body } as Response;
}

const experimentsPayload = {
  experiments: [
    {
      id: 'session.compaction_mode',
      titleKey: 'settings.experiments.compaction.title',
      descriptionKey: 'settings.experiments.compaction.description',
      owner: 'session',
      scope: 'global',
      value: 'auto',
      defaultValue: 'auto',
      valueSchema: {
        type: 'enum',
        presentation: { type: 'select' },
        options: [
          { value: 'auto', labelKey: 'settings.experiments.compaction.auto' },
          { value: 'cache_preserving', labelKey: 'settings.experiments.compaction.cachePreserving' },
          { value: 'pi_compatible', labelKey: 'settings.experiments.compaction.piCompatible' },
        ],
      },
      status: 'beta',
      risk: 'low',
      restartPolicy: 'immediate',
    },
    {
      id: 'memory.cache_snapshot_reflection',
      titleKey: 'settings.experiments.cacheSnapshot.title',
      descriptionKey: 'settings.experiments.cacheSnapshot.description',
      owner: 'memory',
      scope: 'global',
      value: 'off',
      defaultValue: 'off',
      valueSchema: {
        type: 'enum',
        presentation: { type: 'paired_toggles' },
        options: [
          { value: 'off', labelKey: 'settings.experiments.cacheSnapshot.off' },
          { value: 'shadow', labelKey: 'settings.experiments.cacheSnapshot.shadow' },
          { value: 'write', labelKey: 'settings.experiments.cacheSnapshot.write' },
        ],
      },
      status: 'beta',
      risk: 'medium',
      restartPolicy: 'new_session',
    },
    {
      id: 'memory.editable_facts',
      titleKey: 'settings.experiments.editableMemory.title',
      descriptionKey: 'settings.experiments.editableMemory.description',
      owner: 'memory',
      scope: 'global',
      value: false,
      defaultValue: false,
      valueSchema: {
        type: 'boolean',
        presentation: { type: 'toggle' },
      },
      status: 'alpha',
      risk: 'medium',
      restartPolicy: 'immediate',
    },
    {
      id: 'provider.deepseek_roleplay_reasoning_patch',
      titleKey: 'settings.experiments.deepseekRoleplay.title',
      descriptionKey: 'settings.experiments.deepseekRoleplay.description',
      owner: 'provider',
      scope: 'global',
      value: false,
      defaultValue: false,
      valueSchema: {
        type: 'boolean',
        presentation: { type: 'toggle' },
      },
      status: 'alpha',
      risk: 'medium',
      restartPolicy: 'new_session',
    },
    {
      id: 'subagent.proactive_delegation',
      titleKey: 'settings.experiments.proactiveSubagent.title',
      descriptionKey: 'settings.experiments.proactiveSubagent.description',
      owner: 'session',
      scope: 'global',
      value: false,
      defaultValue: false,
      valueSchema: {
        type: 'boolean',
        presentation: { type: 'toggle' },
      },
      status: 'beta',
      risk: 'low',
      restartPolicy: 'new_session',
    },
  ],
};

const observationPayload = {
  observation: {
    status: 'success',
    createdAt: '2026-06-03T00:00:00.000Z',
    sessionPath: '/tmp/session.jsonl',
    trigger: 'threshold',
    usage: { model: 'memory-model', cachedTokens: 10, missTokens: 1, latencyMs: 30 },
    summaryPreview: 'Rolling summary preview',
    memoryMdPreview: 'Memory markdown preview',
  },
};

vi.mock('../../settings/api', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (md: string) => `<p>${md}</p>`,
}));

describe('ExperimentsTab', () => {
  beforeEach(() => {
    gsapFetchMock.mockReset();
    gsapFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        return response({ ok: true, value: JSON.parse(String(opts.body)).value });
      }
      if (opts?.method === 'DELETE') {
        return response({ ok: true, deleted: true });
      }
      if (url === '/api/experiments') return response(experimentsPayload);
      if (url === '/api/experiments/memory/cache-snapshot-reflection/observation?agentId=primary') {
        return response(observationPayload);
      }
      return response({ observation: null });
    });
    window.t = ((key: string) => ({
      'settings.experiments.memoryTitle': 'Memory experiments',
      'settings.experiments.compactionTitle': 'Context compaction',
      'settings.experiments.compactionSectionDescription': 'Choose the context compaction behavior.',
      'settings.experiments.subagentTitle': 'Subagent experiments',
      'settings.experiments.subagentSectionDescription': 'Control delegation behavior for new sessions.',
      'settings.experiments.modelPersonaTitle': 'Model persona experiments',
      'settings.experiments.modelPersonaDescription': 'Tune provider-specific persona and reasoning behavior.',
      'settings.experiments.compaction.title': 'Compaction mode',
      'settings.experiments.compaction.description': 'Auto prefers cache-preserving compaction.',
      'settings.experiments.compaction.auto': 'Auto',
      'settings.experiments.compaction.cachePreserving': 'Cache-preserving compaction',
      'settings.experiments.compaction.piCompatible': 'Normal compaction',
      'settings.experiments.cacheSnapshot.title': 'Cache snapshot memory',
      'settings.experiments.cacheSnapshot.description': 'Generate memory summaries through cache snapshot reflection.',
      'settings.experiments.cacheSnapshot.observeOnly': 'Observe only',
      'settings.experiments.cacheSnapshot.observationNote': 'Shadow mode does not write official memory.',
      'settings.experiments.cacheSnapshot.writeWarning': 'Write mode updates official memory.',
      'settings.experiments.cacheSnapshot.previewTitle': 'Memory preview',
      'settings.experiments.cacheSnapshot.summaryTitle': 'Summary preview',
      'settings.experiments.cacheSnapshot.emptyPreview': 'No observation yet',
      'settings.experiments.cacheSnapshot.clearObservation': 'Clear observation',
      'settings.experiments.editableMemory.title': 'Editable memory',
      'settings.experiments.editableMemory.description': 'Split current memory facts into an editable area.',
      'settings.experiments.deepseekRoleplay.title': 'DeepSeek roleplay reasoning patch',
      'settings.experiments.deepseekRoleplay.description': 'Adds a hidden reasoning marker for DeepSeek V4 persona adherence.',
      'settings.experiments.proactiveSubagent.title': 'Proactive subagent delegation',
      'settings.experiments.proactiveSubagent.description': 'Allows the assistant to delegate after enough independent investigation.',
      'settings.experiments.status.alpha': 'Alpha',
      'settings.experiments.status.beta': 'Beta',
      'settings.experiments.risk.low': 'Low risk',
      'settings.experiments.restart.immediate': 'Immediate',
      'settings.experiments.risk.medium': 'Medium risk',
      'settings.experiments.restart.new_session': 'New sessions',
      'settings.experiments.empty': 'No experiments',
      'settings.computerUse.title': 'Computer control',
      'settings.computerUse.description': 'Control the current computer from eligible sessions.',
      'settings.computerUse.experimentalWarning': 'Computer control is experimental.',
      'settings.computerUse.enabled': 'Enable computer control',
      'settings.computerUse.enabledHint': 'New sessions do not expose computer control tools when disabled.',
      'settings.computerUse.provider': 'Provider',
      'settings.computerUse.availability': 'Availability',
      'settings.computerUse.available': 'Available',
      'settings.computerUse.unavailable': 'Unavailable',
      'settings.computerUse.permissions': 'Request system permissions',
      'settings.computerUse.permissionsHint': 'Request accessibility and screen recording permissions.',
      'settings.computerUse.permissionsStatus': 'System permissions',
      'settings.computerUse.permissionsEmpty': 'No extra permissions required or status not returned',
      'settings.computerUse.approvals': 'Approved apps',
      'settings.computerUse.approvalsEmpty': 'No apps approved',
      'settings.computerUse.activeSession': 'Current usage',
      'settings.computerUse.active': 'Active',
      'settings.computerUse.idle': 'Idle',
      'settings.computerUse.refresh': 'Refresh',
      'settings.computerUse.requestPermissions': 'Request permissions',
      'settings.computerUse.requestPermissionsFailed': 'Request permissions failed',
      'settings.autoSaved': 'Auto-saved',
    }[key] || key)) as typeof window.t;
    useSettingsStore.setState({
      platformName: 'win32',
      agents: [
        { id: 'secondary', name: 'Secondary', yuan: 'gsap', isPrimary: false },
        { id: 'primary', name: 'Primary', yuan: 'gsap', isPrimary: true },
      ],
      toastVisible: false,
      toastMessage: '',
      toastType: '',
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('maps paired toggles to shadow/write and can clear the latest observation', async () => {
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');
    render(<ExperimentsTab />);

    expect(await screen.findByText('Computer control')).toBeInTheDocument();

    const main = await screen.findByRole('switch', { name: 'Cache snapshot memory' });
    expect(main).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(main);

    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory.cache_snapshot_reflection',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: 'shadow' }),
        }),
      );
    });
    expect(await screen.findByText('Rolling summary preview')).toBeInTheDocument();

    const observeOnly = await screen.findByRole('switch', { name: 'Observe only' });
    expect(observeOnly).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(observeOnly);

    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory.cache_snapshot_reflection',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: 'write' }),
        }),
      );
    });
    expect(screen.getByText(/Write mode updates official memory/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear observation' }));
    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory/cache-snapshot-reflection/observation?agentId=primary',
        { method: 'DELETE' },
      );
    });
  });

  it('hides computer control in Linux preview settings', async () => {
    useSettingsStore.setState({ platformName: 'linux' });
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');

    render(<ExperimentsTab />);

    expect(screen.queryByText('Computer control')).not.toBeInTheDocument();
    expect(await screen.findByText('Memory experiments')).toBeInTheDocument();
  });

  it('renders session compaction mode and saves selected values', async () => {
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');
    render(<ExperimentsTab />);

    expect(await screen.findByText('Context compaction')).toBeInTheDocument();
    expect(screen.getByText('Compaction mode')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Normal compaction' }));

    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/session.compaction_mode',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: 'pi_compatible' }),
        }),
      );
    });
  });

  it('renders provider and subagent boolean experiments and saves toggles', async () => {
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');
    render(<ExperimentsTab />);

    expect(await screen.findByText('Subagent experiments')).toBeInTheDocument();
    expect(screen.getByText('Model persona experiments')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Proactive subagent delegation' }));
    fireEvent.click(screen.getByRole('switch', { name: 'DeepSeek roleplay reasoning patch' }));

    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/subagent.proactive_delegation',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: true }),
        }),
      );
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/provider.deepseek_roleplay_reasoning_patch',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: true }),
        }),
      );
    });
  });

  it('renders editable memory experiment and saves the toggle', async () => {
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');
    render(<ExperimentsTab />);

    const editableMemory = await screen.findByRole('switch', { name: 'Editable memory' });
    expect(editableMemory).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(editableMemory);

    await waitFor(() => {
      expect(gsapFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory.editable_facts',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: true }),
        }),
      );
    });
  });
});
