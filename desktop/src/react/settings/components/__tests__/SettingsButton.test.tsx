/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsButton } from '../SettingsButton';

describe('SettingsButton', () => {
  it('maps variants to the shared settings button styles', () => {
    render(
      <>
        <SettingsButton variant="primary">Save</SettingsButton>
        <SettingsButton variant="secondary">Copy</SettingsButton>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('settings-btn-primary');
    expect(screen.getByRole('button', { name: 'Copy' }).className).toContain('settings-btn-secondary');
  });

  it('defaults to type button to avoid submitting wrapping forms', () => {
    render(<SettingsButton>Action</SettingsButton>);

    expect(screen.getByRole('button', { name: 'Action' }).getAttribute('type')).toBe('button');
  });
});
