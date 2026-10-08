// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingLevelButton } from '../../components/input/ThinkingLevelButton';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/use-gsap-fetch', () => ({
  gsapFetch: vi.fn(),
}));

const storeState = {
  currentSessionPath: null,
  pendingNewSession: true,
  setPendingNewSessionThinkingLevel: vi.fn(),
};

vi.mock('../../stores', () => ({
  useStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

describe('ThinkingLevelButton localization fallback', () => {
  beforeEach(() => {
    storeState.setPendingNewSessionThinkingLevel.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not expose raw enum values in Chinese UI when i18n keys are missing', () => {
    render(<ThinkingLevelButton level="medium" onChange={vi.fn()} availableLevels={['off', 'medium', 'high', 'max']} />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByRole('option', { name: /^medium$/i })).toBeNull();
    expect(screen.getByRole('option', { name: /中等/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /不推理/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /深度/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /极限/ })).toBeTruthy();
  });
});
