/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsUpdateCard } from '../../components/chat/SettingsUpdateCard';

describe('SettingsUpdateCard', () => {
  it('renders a read-only settings update without confirmation actions', () => {
    render(
      <SettingsUpdateCard
        update={{
          status: 'applied',
          action: 'core.apply',
          key: 'locale',
          title: '语言已更新',
          summary: '语言从 zh-CN 切换到 en。',
          changes: [
            { key: 'locale', label: '语言', before: 'zh-CN', after: 'en' },
          ],
        }}
      />,
    );

    expect(screen.getByText('语言已更新')).toBeTruthy();
    expect(screen.getByText('语言从 zh-CN 切换到 en。')).toBeTruthy();
    expect(screen.getByText('已应用')).toBeTruthy();
    expect(screen.getByText('zh-CN -> en')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
