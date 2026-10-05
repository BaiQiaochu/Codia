// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InputStatusBars } from '../../components/input/InputStatusBars';

describe('InputStatusBars', () => {
  it('shows screenshot progress above the chat input', () => {
    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel="Executing..."
        compacting={false}
        compactingLabel="Compacting"
        screenshotBusy
        screenshotLabel="Taking screenshot"
        screenshotPageLabel="Taking screenshot, page 2/4"
        screenshotProgress={{
          completedBlocks: 12,
          totalBlocks: 37,
          currentPage: 2,
          totalPages: 4,
        }}
        inlineError={null}
        slashResult={null}
        onResultClick={undefined}
      />,
    );

    expect(screen.getByText('Taking screenshot, page 2/4')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: 'Taking screenshot, page 2/4' });
    expect(progress).toHaveAttribute('aria-valuenow', '12');
    expect(progress).toHaveAttribute('aria-valuemax', '37');
  });

  it('keeps clickable slash results keyboard accessible', () => {
    const onResultClick = vi.fn();

    render(
      <InputStatusBars
        slashBusy={null}
        slashBusyLabel="Executing..."
        compacting={false}
        compactingLabel="Compacting"
        screenshotBusy={false}
        screenshotLabel="Taking screenshot"
        screenshotProgress={null}
        inlineError={null}
        slashResult={{ text: 'Saved', type: 'success', deskDir: 'C:/work' }}
        onResultClick={onResultClick}
      />,
    );

    const button = screen.getByRole('button', { name: /Saved/ });
    expect(button).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.click(button);

    expect(onResultClick).toHaveBeenCalledTimes(3);
  });
});
