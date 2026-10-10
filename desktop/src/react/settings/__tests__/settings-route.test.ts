import { describe, expect, it } from 'vitest';
import { normalizeSettingsRouteId } from '../settings-route';

describe('settings route normalization', () => {
  it.each([
    ['general', 'about'],
    ['interface', 'about'],
    ['license', 'diagnostics'],
    ['search', 'providers'],
    ['experiments', 'context'],
    ['computer', 'computer'],
    ['plugin-marketplace', 'plugin-marketplace'],
  ])('routes %s to %s', (input, expected) => {
    expect(normalizeSettingsRouteId(input)).toBe(expected);
  });

  it('uses the assistant page for an empty route', () => {
    expect(normalizeSettingsRouteId('')).toBe('agent');
  });
});
