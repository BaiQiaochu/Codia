// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeClipboardTextMock = vi.fn(async (..._args: unknown[]) => true);

vi.mock('../../components/ContextMenu', () => ({
  ContextMenu: ({ items }: { items: Array<{ label?: string; action?: () => void; divider?: boolean }> }) => (
    <div data-testid="mock-context-menu">
      {items.filter((item) => !item.divider).map((item, index) => (
        <button key={`${item.label || 'item'}-${index}`} type="button" onClick={() => item.action?.()}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../../utils/clipboard', () => ({
  writeClipboardText: (...args: unknown[]) => writeClipboardTextMock(...args),
}));

describe('InputContextMenu', () => {
  beforeEach(() => {
    (window as typeof window & { t?: (key: string) => string }).t = (key: string) => key;
    document.execCommand = vi.fn(() => false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('copies full readonly input value when no text is selected', async () => {
    const { InputContextMenu } = await import('../../components/InputContextMenu');

    render(
      <>
        <input data-testid="field" readOnly value="http://127.0.0.1:6424" />
        <InputContextMenu />
      </>,
    );

    fireEvent.contextMenu(screen.getByTestId('field'), { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByText('ctx.copy'));

    await waitFor(() => {
      expect(writeClipboardTextMock).toHaveBeenCalledWith('http://127.0.0.1:6424');
    });
  });

  it('copies only the selected slice for text inputs', async () => {
    const { InputContextMenu } = await import('../../components/InputContextMenu');

    render(
      <>
        <input data-testid="field" readOnly value="Bearer token-example" />
        <InputContextMenu />
      </>,
    );

    const input = screen.getByTestId('field') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(7, 20);

    fireEvent.contextMenu(input, { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByText('ctx.copy'));

    await waitFor(() => {
      expect(writeClipboardTextMock).toHaveBeenCalledWith('token-example');
    });
  });
});
