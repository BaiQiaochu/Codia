import { describe, expect, it } from 'vitest';
import { getApiErrorMessage } from '../../utils/api-error';

describe('getApiErrorMessage', () => {
  it('reads legacy string errors', () => {
    expect(getApiErrorMessage({ error: 'not found' })).toBe('not found');
  });

  it('reads structured route error messages', () => {
    expect(getApiErrorMessage({
      error: { code: 'activity_not_found', message: 'activity not found' },
    })).toBe('activity not found');
  });

  it('falls back to structured code when message is missing', () => {
    expect(getApiErrorMessage({ error: { code: 'cron_store_unavailable' } }))
      .toBe('cron_store_unavailable');
  });
});
