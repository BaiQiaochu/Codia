// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityDriftNotice } from '../../components/input/CapabilityDriftNotice';
import {
  dismissSessionCapabilityDrift,
  refreshSessionCapabilities,
} from '../../stores/session-actions';
import type { SessionCapabilityDrift } from '../../types';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params ? `${key}:${JSON.stringify(params)}` : key
    ),
  }),
}));

vi.mock('../../stores/session-actions', () => ({
  dismissSessionCapabilityDrift: vi.fn(() => Promise.resolve(true)),
  refreshSessionCapabilities: vi.fn(() => Promise.resolve(true)),
}));

function makeDrift(overrides: Partial<SessionCapabilityDrift> = {}): SessionCapabilityDrift {
  return {
    version: 1,
    fingerprint: 'fp-live',
    frozenFingerprint: 'fp-frozen',
    addedToolNames: ['office'],
    removedToolNames: [],
    invalidToolNames: [],
    promptChanged: false,
    hasDrift: true,
    ...overrides,
  };
}

describe('CapabilityDriftNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders added tools count and the title', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    expect(screen.getByText('session.capabilityDrift.title')).toBeInTheDocument();
    expect(screen.getByText(/addedTools:\{"count":1\}/)).toBeInTheDocument();
  });

  it('merges removed and invalid tool counts into the unavailable segment', () => {
    render(<CapabilityDriftNotice
      sessionPath="/tmp/s.jsonl"
      drift={makeDrift({
        addedToolNames: [],
        removedToolNames: ['browser'],
        invalidToolNames: ['retired_tool'],
      })}
    />);
    expect(screen.getByText(/removedTools:\{"count":2\}/)).toBeInTheDocument();
  });

  it('dismiss passes the live fingerprint through', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    fireEvent.click(screen.getByText('session.capabilityDrift.dismissButton'));
    expect(dismissSessionCapabilityDrift).toHaveBeenCalledWith('/tmp/s.jsonl', 'fp-live');
  });

  it('refresh requires an explicit confirmation step before calling the action', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    fireEvent.click(screen.getByText('session.capabilityDrift.refreshButton'));
    expect(refreshSessionCapabilities).not.toHaveBeenCalled();
    expect(screen.getByText('session.capabilityDrift.confirmText')).toBeInTheDocument();

    fireEvent.click(screen.getByText('session.capabilityDrift.confirmButton'));
    expect(refreshSessionCapabilities).toHaveBeenCalledWith('/tmp/s.jsonl', expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeout: expect.any(Number),
    }));
  });

  it('shows refreshing immediately after confirmation so the prompt cannot loop on repeated clicks', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    fireEvent.click(screen.getByText('session.capabilityDrift.refreshButton'));
    fireEvent.click(screen.getByText('session.capabilityDrift.confirmButton'));

    expect(screen.getByText('session.capabilityDrift.refreshing')).toBeInTheDocument();
    expect(screen.queryByText('session.capabilityDrift.confirmButton')).not.toBeInTheDocument();
    expect(refreshSessionCapabilities).toHaveBeenCalledTimes(1);
  });

  it('shows a failure state and notice event when refresh fails', async () => {
    vi.mocked(refreshSessionCapabilities).mockResolvedValueOnce(false);
    const notices: unknown[] = [];
    const onNotice = (event: Event) => {
      notices.push((event as CustomEvent).detail);
    };
    window.addEventListener('gsap-inline-notice', onNotice);
    try {
      render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
      fireEvent.click(screen.getByText('session.capabilityDrift.refreshButton'));
      fireEvent.click(screen.getByText('session.capabilityDrift.confirmButton'));

      expect(await screen.findByRole('alert')).toHaveTextContent('session.capabilityDrift.refreshFailed');
      expect(screen.getByText('session.capabilityDrift.refreshButton')).toBeInTheDocument();
      await waitFor(() => {
        expect(notices).toContainEqual({
          type: 'error',
          text: 'session.capabilityDrift.refreshFailed',
        });
      });
    } finally {
      window.removeEventListener('gsap-inline-notice', onNotice);
    }
  });
});
