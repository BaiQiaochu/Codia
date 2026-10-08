// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderStep } from '../steps/ProviderStep';
import { LocaleStep } from '../steps/LocaleStep';
import { NameStep } from '../steps/NameStep';
import { WorkspaceStep } from '../steps/WorkspaceStep';
import type { gsapFetch } from '../onboarding-actions';

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
beforeEach(() => {
  vi.stubGlobal('t', (key: string) => key);
  vi.stubGlobal('i18n', { locale: 'en' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function selectProvider(name = 'OpenAI') {
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.selectPlaceholder' }));
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.change(screen.getByPlaceholderText('onboarding.provider.keyPlaceholder'), { target: { value: 'synthetic-key' } });
}
function renderProvider(fetch: gsapFetch) {
  const goToStep = vi.fn();
  const onProviderReady = vi.fn();
  const showError = vi.fn();
  render(<ProviderStep preview={false} gsapFetch={fetch} goToStep={goToStep} onProviderReady={onProviderReady} showError={showError} />);
  return { goToStep, onProviderReady, showError };
}

describe('onboarding request ownership', () => {
  it('does not leave the locale step after its save fails', async () => {
    const fetch = vi.fn<gsapFetch>(async () => json({ error: 'locale save failed' }, 500));
    const goToStep = vi.fn();
    const showError = vi.fn();
    render(<LocaleStep preview={false} gsapFetch={fetch} avatarSrc="" initialLocale="en" goToStep={goToStep} showError={showError} onLocaleChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.welcome.next' }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(goToStep).not.toHaveBeenCalled();
  });

  it.each([400, 500])('keeps the name step open after HTTP %s, then allows retry', async status => {
    const fetch = vi.fn<gsapFetch>()
      .mockResolvedValueOnce(json({ error: 'identity save failed' }, status))
      .mockResolvedValueOnce(json({ ok: true }));
    const goToStep = vi.fn();
    const showError = vi.fn();
    render(<NameStep preview={false} gsapFetch={fetch} goToStep={goToStep} showError={showError} />);
    fireEvent.change(screen.getByPlaceholderText('onboarding.name.placeholder'), { target: { value: 'Test User' } });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.name.next' }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(goToStep).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('onboarding.name.placeholder')).toHaveValue('Test User');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.name.next' }));
    await waitFor(() => expect(goToStep).toHaveBeenCalledExactlyOnceWith(2));
  });

  it('keeps the workspace step open when its config write fails after directory creation', async () => {
    const fetch = vi.fn<gsapFetch>(async (url, init) => {
      if (url.endsWith('/default-workspace')) return json({ path: '/workspace/default' });
      expect(init?.method).toBe('PUT');
      return json({ error: 'workspace save failed' }, 500);
    });
    const goToStep = vi.fn();
    const showError = vi.fn();
    render(<WorkspaceStep preview={false} gsapFetch={fetch} goToStep={goToStep} showError={showError} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'onboarding.workspace.next' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.workspace.next' }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(goToStep).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'onboarding.workspace.next' })).toBeEnabled();
  });

  it('keeps provider details uncommitted on a rejected save and allows retry', async () => {
    const fetch = vi.fn<gsapFetch>()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ error: 'provider save failed' }, 400))
      .mockResolvedValueOnce(json({ ok: true }));
    const { goToStep, onProviderReady, showError } = renderProvider(fetch);
    selectProvider();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(goToStep).not.toHaveBeenCalled();
    expect(onProviderReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
    await waitFor(() => expect(goToStep).toHaveBeenCalledExactlyOnceWith(3));
    expect(onProviderReady).toHaveBeenCalledExactlyOnceWith('openai', 'https://api.openai.com/v1', 'openai-completions', 'synthetic-key');
  });

  it('ignores a successful connection test after the key is edited', async () => {
    const pending = deferredResponse();
    const fetch = vi.fn<gsapFetch>().mockReturnValueOnce(pending.promise);
    const { goToStep } = renderProvider(fetch);
    selectProvider();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    fireEvent.change(screen.getByPlaceholderText('onboarding.provider.keyPlaceholder'), { target: { value: 'changed-key' } });
    await act(async () => pending.resolve(json({ ok: true })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    expect(screen.queryByText('onboarding.provider.testSuccess')).not.toBeInTheDocument();
    expect(goToStep).not.toHaveBeenCalled();
  });

  it('does not replace a newer provider test with an older response', async () => {
    const older = deferredResponse();
    const newer = deferredResponse();
    const fetch = vi.fn<gsapFetch>().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    renderProvider(fetch);
    selectProvider();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    await act(async () => newer.resolve(json({ ok: true })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeEnabled();
    await act(async () => older.resolve(json({ ok: false, error: 'old provider failed' })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeEnabled();
    expect(screen.queryByText('old provider failed')).not.toBeInTheDocument();
  });

  it.each(['URL', 'API'] as const)('invalidates an in-flight custom provider test when its %s changes', async field => {
    const pending = deferredResponse();
    const fetch = vi.fn<gsapFetch>().mockReturnValueOnce(pending.promise);
    renderProvider(fetch);
    selectProvider('onboarding.provider.custom');
    fireEvent.change(screen.getByPlaceholderText('onboarding.provider.customNamePlaceholder'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByPlaceholderText('onboarding.provider.customUrlPlaceholder'), { target: { value: 'https://example.invalid/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    if (field === 'URL') {
      fireEvent.change(screen.getByPlaceholderText('onboarding.provider.customUrlPlaceholder'), { target: { value: 'https://new.invalid/v1' } });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'OpenAI Compatible' }));
      fireEvent.click(screen.getByRole('option', { name: 'Anthropic Messages' }));
    }
    await act(async () => pending.resolve(json({ ok: true })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    expect(screen.queryByText('onboarding.provider.testSuccess')).not.toBeInTheDocument();
  });

  it('keeps the newest failed test after an older successful response arrives', async () => {
    const older = deferredResponse();
    const newer = deferredResponse();
    const fetch = vi.fn<gsapFetch>().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    renderProvider(fetch);
    selectProvider();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    await act(async () => newer.resolve(json({ ok: false, error: 'current validation failed' })));
    await act(async () => older.resolve(json({ ok: true })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    expect(screen.getByText('current validation failed')).toBeInTheDocument();
  });

  it('keeps a new provider step unvalidated after leaving the pending step', async () => {
    const pending = deferredResponse();
    const fetch = vi.fn<gsapFetch>().mockReturnValueOnce(pending.promise);
    const goToStep = vi.fn();
    const view = render(<ProviderStep preview={false} gsapFetch={fetch} goToStep={goToStep} showError={vi.fn()} onProviderReady={vi.fn()} />);
    selectProvider();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.back' }));
    expect(goToStep).toHaveBeenCalledExactlyOnceWith(1);
    view.unmount();
    renderProvider(fetch);
    selectProvider('DeepSeek');
    await act(async () => pending.resolve(json({ ok: true })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    expect(screen.queryByText('onboarding.provider.testSuccess')).not.toBeInTheDocument();
  });

  it('keeps preview navigation available without testing or persisting credentials', () => {
    const fetch = vi.fn<gsapFetch>();
    const goToStep = vi.fn();
    render(<ProviderStep preview gsapFetch={fetch} goToStep={goToStep} showError={vi.fn()} onProviderReady={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
    expect(goToStep).toHaveBeenCalledExactlyOnceWith(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the latest repeated test to pass before allowing Next', async () => {
    const pending = deferredResponse();
    const fetch = vi.fn<gsapFetch>().mockResolvedValueOnce(json({ ok: true })).mockReturnValueOnce(pending.promise);
    renderProvider(fetch);
    selectProvider();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    await act(async () => pending.resolve(json({ ok: false, error: 'service unavailable' })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
  });
});
