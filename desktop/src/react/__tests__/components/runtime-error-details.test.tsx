// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../../components/ToastContainer';
import { useStore } from '../../stores';

function extractRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return match?.[1] || '';
}

describe('runtime error toast details', () => {
  beforeEach(() => {
    window.t = (key: string) => ({
      'diagnostics.runtime.toast.details': 'Details',
      'diagnostics.runtime.toast.hideDetails': 'Hide details',
      'diagnostics.runtime.copyPackage': 'Copy diagnostics',
      'diagnostics.runtime.copySuccess': 'Diagnostics copied',
      'diagnostics.runtime.traceId': 'Trace',
      'diagnostics.runtime.session': 'Session',
      'diagnostics.runtime.model': 'Model',
      'diagnostics.runtime.tool': 'Tool',
      'diagnostics.runtime.category': 'Category',
      'diagnostics.runtime.duration': 'Duration',
      'diagnostics.runtime.suggestion': 'Suggestion',
      'diagnostics.runtime.technical': 'Technical',
    } as Record<string, string>)[key] || key;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    useStore.setState({
      toasts: [],
      runtimeDiagnosticsById: {},
      runtimeDiagnosticIds: [],
      runtimeRecords: [],
      runtimeTimelineByTrace: {},
      runtimeTimelineTraceIdsBySession: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('expands technical details and copies a redacted diagnostic package', async () => {
    const diagnosticId = useStore.getState().recordRuntimeDiagnostic({
      id: 'diag-1',
      traceId: 'trace-1',
      sessionPath: 'sessions/a.jsonl',
      severity: 'error',
      category: 'tool',
      userMessage: 'Tool call failed. Diagnostics were saved.',
      technicalMessage: 'tool failed with token sk-secret',
      suggestion: 'Retry after checking tool permission.',
      tool: { name: 'read' },
      durationMs: 42,
    });
    useStore.getState().addToast('Tool call failed. Diagnostics were saved.', 'error', 0, {
      diagnosticId,
      persistent: true,
    });

    render(<ToastContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('trace-1')).toBeTruthy();
    expect(screen.getByText('sessions/a.jsonl')).toBeTruthy();
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.getByText('Retry after checking tool permission.')).toBeTruthy();
    expect(screen.getByText((content) => content.includes('[REDACTED]'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    });
    expect(String(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0])).not.toContain('sk-secret');
  });

  it('keeps diagnostic details readable in desktop and mobile theme CSS', () => {
    const desktopCss = readFileSync(path.join(process.cwd(), 'desktop/src/styles.css'), 'utf8');
    const mobileCss = readFileSync(path.join(process.cwd(), 'desktop/src/react/mobile/mobile-entry.css'), 'utf8');

    for (const css of [desktopCss, mobileCss]) {
      expect(extractRule(css, '.gsap-toast.error')).toContain('color: var(--text-primary)');
      expect(extractRule(css, '.gsap-toast-diagnostic')).toContain('background: var(--bg-elevated');
      expect(extractRule(css, '.gsap-toast-diagnostic-row strong')).toContain('overflow-wrap: anywhere');
    }
  });
});
