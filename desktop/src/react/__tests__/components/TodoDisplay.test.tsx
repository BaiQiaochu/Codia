// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TodoDisplay } from '../../components/input/TodoDisplay';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'common.allDone': 'All done',
      'common.markAllComplete': 'Mark all complete',
    }[key] || key),
  }),
}));

describe('TodoDisplay', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a complete-all action when a handler is provided', () => {
    const onCompleteAll = vi.fn();
    render(
      <TodoDisplay
        todos={[{ content: 'Ship the fix', activeForm: 'Shipping the fix', status: 'in_progress' }]}
        onCompleteAll={onCompleteAll}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Shipping the fix/i }));
    fireEvent.click(screen.getByRole('button', { name: /Mark all complete/i }));

    expect(onCompleteAll).toHaveBeenCalledTimes(1);
  });

  it('disables the complete-all action while completion is in flight', () => {
    render(
      <TodoDisplay
        todos={[{ content: 'Ship the fix', activeForm: 'Shipping the fix', status: 'in_progress' }]}
        onCompleteAll={() => {}}
        completing
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Shipping the fix/i }));

    expect(screen.getByRole('button', { name: /Mark all complete/i })).toHaveProperty('disabled', true);
  });
});
