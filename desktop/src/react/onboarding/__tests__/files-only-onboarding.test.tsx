// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingApp } from '../OnboardingApp';
import { TutorialStep } from '../steps/TutorialStep';

const complete = vi.fn();
let writes: Record<string, unknown>[];

beforeEach(() => {
  localStorage.clear();
  writes = [];
  complete.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('t', (key: string) => key);
  vi.stubGlobal('i18n', { locale: 'en', defaultName: 'Codia', load: vi.fn().mockResolvedValue(undefined) });
  vi.stubGlobal('gsap', {
    getServerPort: async () => '14500', getServerToken: async () => 'existing-token',
    getSplashInfo: async () => ({ locale: 'en' }), onboardingComplete: complete,
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.body) writes.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(String(input).endsWith('/default-workspace') ? { path: '/workspace/files' } : { ok: true }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function reachProvider() {
  render(<OnboardingApp preview={false} skipToTutorial={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'onboarding.welcome.next' }));
  fireEvent.change(await screen.findByPlaceholderText('onboarding.name.placeholder'), { target: { value: 'Test User' } });
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.name.next' }));
  await screen.findByTestId('use-files-only');
}

describe('explicit file-only desktop onboarding', () => {
  it('completes the real wizard without creating a provider/model or enabling AI', async () => {
    await reachProvider();
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    fireEvent.click(screen.getByTestId('use-files-only'));
    expect(screen.getByRole('heading', { name: 'onboarding.theme.title' })).toBeInTheDocument();
    // Back returns to the choice, not the model step with missing credentials.
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.theme.back' }));
    expect(screen.getByTestId('use-files-only')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('use-files-only'));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.theme.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'onboarding.workspace.next' })).toBeEnabled());
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.workspace.next' }));
    expect(await screen.findByText('onboarding.tutorial.filesOnlyHint')).toBeInTheDocument();
    expect(screen.queryByText('onboarding.tutorial.memory.title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.tutorial.finish' }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.tutorial.finish' }));
    await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith({ mode: 'files-only' }));
    expect(writes.some(body => 'providers' in body || 'models' in body || 'api' in body)).toBe(false);
    expect(writes.some(body => 'desk' in body)).toBe(true);
  });

  it('allows retry after a failed completion without silently switching mode', async () => {
    complete.mockRejectedValueOnce(new Error('not persisted')).mockResolvedValueOnce(undefined);
    const showError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TutorialStep preview={false} setupMode="files-only" showError={showError} />);
    const finish = screen.getByRole('button', { name: 'onboarding.tutorial.finish' });
    fireEvent.click(finish);
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(finish).toBeEnabled();
    fireEvent.click(finish);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(complete).toHaveBeenLastCalledWith({ mode: 'files-only' });
  });

  it('leaves the AI path explicit for ordinary completion', async () => {
    render(<TutorialStep preview={false} showError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.tutorial.finish' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith({ mode: 'ai' }));
  });
});
