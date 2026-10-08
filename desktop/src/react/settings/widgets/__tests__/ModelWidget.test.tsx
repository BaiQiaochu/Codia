/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelWidget } from '../ModelWidget';

const mocks = vi.hoisted(() => ({
  gsapFetch: vi.fn(),
}));

vi.mock('../../api', () => ({
  gsapFetch: (...args: unknown[]) => mocks.gsapFetch(...args),
}));

const t = (key: string) => ({
  'settings.api.selectModel': 'Select model',
  'settings.api.searchModel': 'Search model',
  'settings.api.customInput': 'Custom...',
  'settings.api.noModels': 'No models added yet',
  'settings.api.clearModel': 'Clear',
}[key] || key);

const imageCapableOnly = (model: { input?: string[]; image?: boolean; vision?: boolean }) => (
  model.image === true
  || model.vision === true
  || (Array.isArray(model.input) && model.input.includes('image'))
);

describe('ModelWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { t: typeof t }).t = t;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as unknown as { t?: typeof t }).t;
  });

  it('opens the model popup from a body portal and selects a vision model', async () => {
    mocks.gsapFetch.mockResolvedValue({
      json: async () => ({
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', input: ['text', 'image'], vision: true },
          { id: 'text-only', name: 'Text Only', provider: 'openai', input: ['text'], vision: false },
        ],
      }),
    });
    const onSelect = vi.fn();

    render(
      <ModelWidget
        value={null}
        onSelect={onSelect}
        modelsPath="/api/models?include=vision"
        filterModel={imageCapableOnly}
      />,
    );

    await waitFor(() => expect(mocks.gsapFetch).toHaveBeenCalledWith('/api/models?include=vision'));
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));

    await waitFor(() => expect(document.body.querySelector('[data-mdw-popup]')).toBeTruthy());
    expect(screen.getByPlaceholderText('Search model')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Text Only' })).toBeNull();
    fireEvent.scroll(window);
    expect(document.body.querySelector('[data-mdw-popup]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'GPT-4o' }));

    expect(onSelect).toHaveBeenCalledWith({ id: 'gpt-4o', provider: 'openai' });
    expect(document.body.querySelector('[data-mdw-popup]')).toBeNull();
  });

  it('trims custom provider/id input before selecting', async () => {
    mocks.gsapFetch.mockResolvedValue({
      json: async () => ({ models: [] }),
    });
    const onSelect = vi.fn();

    render(<ModelWidget value={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    fireEvent.change(screen.getByPlaceholderText('Custom... (provider/id)'), {
      target: { value: ' openai / gpt-4o ' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('Custom... (provider/id)'), { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ id: 'gpt-4o', provider: 'openai' });
  });

  it('positions the popup with a top coordinate when it opens above the trigger', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    mocks.gsapFetch.mockResolvedValue({
      json: async () => ({
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        ],
      }),
    });

    render(<ModelWidget value={null} onSelect={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: /Select model/ });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 540,
      top: 540,
      left: 24,
      right: 324,
      bottom: 572,
      width: 300,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(trigger);

    await waitFor(() => expect(document.body.querySelector('[data-mdw-popup]')).toBeTruthy());
    const popup = document.body.querySelector('[data-mdw-popup]') as HTMLElement;
    expect(popup.style.top).not.toBe('');
    expect(popup.style.bottom).toBe('auto');

    fireEvent.scroll(window);
    expect(document.body.querySelector('[data-mdw-popup]')).toBeTruthy();
    expect((document.body.querySelector('[data-mdw-popup]') as HTMLElement).style.bottom).toBe('auto');
  });
});
