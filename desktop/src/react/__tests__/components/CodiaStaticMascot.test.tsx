// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CodiaStaticMascot } from '../../components/CodiaStaticMascot';

afterEach(cleanup);
describe('always-visible static Codia artwork', () => {
  it('renders accessible bundled artwork without a canvas, SDK or hide animation', () => {
    const { container } = render(<CodiaStaticMascot />);
    expect(screen.getByRole('img', { name: 'Codia 吉祥物（静态）' })).toBeVisible();
    expect(container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('codia-mascot-gaze-strip'));
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('[data-codia-static-mascot]')).toBeVisible();
  });
});
