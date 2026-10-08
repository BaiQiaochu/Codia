/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsSection } from '../SettingsSection';

describe('SettingsSection', () => {
  afterEach(() => cleanup());

  it('passes through standard div props on note and warning blocks', () => {
    render(
      <SettingsSection>
        <SettingsSection.Note data-testid="settings-note" className="custom-note">
          note
        </SettingsSection.Note>
        <SettingsSection.Warning data-testid="settings-warning" className="custom-warning">
          warning
        </SettingsSection.Warning>
      </SettingsSection>,
    );

    expect(screen.getByTestId('settings-note')).toHaveClass('custom-note');
    expect(screen.getByTestId('settings-warning')).toHaveClass('custom-warning');
  });
});
