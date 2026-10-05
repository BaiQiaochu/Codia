// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillBundleTree } from '../skills/SkillBundleTree';

describe('SkillBundleTree highlights', () => {
  afterEach(() => cleanup());

  it('marks highlighted bundles and skills for install feedback', () => {
    render(
      <SkillBundleTree
        mode="manage"
        bundles={[{
          id: 'bundle-a',
          name: 'Bundle A',
          skillNames: ['planning'],
        }]}
        skills={[{
          name: 'planning',
          description: 'Plan work',
          enabled: true,
          source: 'user',
        }]}
        nameHints={{}}
        emptyText="empty"
        highlightedBundleId="bundle-a"
        highlightedSkillName="planning"
      />,
    );

    expect(screen.getByTestId('skill-bundle-header-bundle-a').getAttribute('data-highlighted')).toBe('true');
    expect(screen.getByTestId('skill-row-planning').getAttribute('data-highlighted')).toBe('true');
  });

  it('can be controlled by a parent-owned expanded state', () => {
    const onExpandedStateChange = vi.fn();

    render(
      <SkillBundleTree
        mode="manage"
        bundles={[{
          id: 'bundle-a',
          name: 'Bundle A',
          skillNames: ['planning'],
        }]}
        skills={[{
          name: 'planning',
          description: 'Plan work',
          enabled: true,
          source: 'user',
        }]}
        nameHints={{}}
        emptyText="empty"
        expandedState={{ 'bundle-a': true }}
        onExpandedStateChange={onExpandedStateChange}
      />,
    );

    expect(screen.getByTestId('skill-row-planning')).toBeTruthy();
    const caret = screen.getByTestId('skill-bundle-header-bundle-a').querySelector('button');
    expect(caret).toBeTruthy();
    fireEvent.click(caret as HTMLButtonElement);
    expect(onExpandedStateChange).toHaveBeenCalledWith({ 'bundle-a': false });
  });
});
