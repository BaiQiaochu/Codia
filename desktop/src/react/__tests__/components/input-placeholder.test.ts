import { describe, expect, it } from 'vitest';

import { resolveInputPlaceholder } from '../../components/input/input-placeholder';

describe('input placeholder resolution', () => {
  it('does not expose the i18n key while translations are still loading', () => {
    const t = (key: string) => key;

    expect(resolveInputPlaceholder({ agentYuan: 'codia', locale: 'zh-CN', t })).toBe('说点什么...');
  });

  it('prefers the yuan-specific placeholder when it is translated', () => {
    const t = (key: string) => ({
      'yuan.placeholder.codia': '今天想做什么？',
      'input.placeholder': '说点什么...',
    }[key] || key);

    expect(resolveInputPlaceholder({ agentYuan: 'codia', locale: 'zh-CN', t })).toBe('今天想做什么？');
  });
});
