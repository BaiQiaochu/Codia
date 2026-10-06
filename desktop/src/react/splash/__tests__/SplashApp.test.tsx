/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SplashApp } from '../SplashApp';

describe('Codia splash branding', () => {
  it('shows the shared product emblem during initialization', () => {
    render(<SplashApp />);
    expect(screen.getByRole('img', { name: 'Codia' }).getAttribute('src')).toContain('codia-brand-emblem.png');
    expect(screen.getByText('正在初始化…')).toBeTruthy();
  });
});
