// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React, { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputUtilityButtons } from '../../components/input/InputUtilityButtons';
import { useStore } from '../../stores';

const t = (key: string) => ({
  'input.attachFiles': '添加附件',
  'skills.panel.title': '技能',
  'input.commandMenu': '命令菜单',
}[key] || key);

describe('InputUtilityButtons', () => {
  beforeEach(() => useStore.setState({ activePanel: null }));
  afterEach(cleanup);

  it('opens the existing desktop skills panel and dismisses the composer popup first', () => {
    const beforeOpen = vi.fn(() => expect(useStore.getState().activePanel).toBeNull());
    render(<InputUtilityButtons t={t} onAttach={vi.fn()} onBeforeOpenSkills={beforeOpen} />);
    const skills = screen.getByRole('button', { name: '技能' });
    fireEvent.click(skills);
    expect(beforeOpen).toHaveBeenCalledOnce();
    expect(useStore.getState().activePanel).toBe('skills');
    expect(skills).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: '命令菜单' })).toBeNull();
  });

  it('keeps attachment action and read-only disabling', () => {
    const onAttach = vi.fn();
    const { rerender } = render(<InputUtilityButtons t={t} onAttach={onAttach} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    expect(onAttach).toHaveBeenCalledOnce();
    rerender(<InputUtilityButtons t={t} onAttach={onAttach} attachDisabled />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it('keeps the mobile star connected to its existing slash menu', () => {
    const onToggle = vi.fn();
    const buttonRef = createRef<HTMLButtonElement>();
    render(<InputUtilityButtons t={t} onAttach={vi.fn()} mobileCommands={{ open: false, onToggle, buttonRef }} />);
    const commands = screen.getByRole('button', { name: '命令菜单' });
    fireEvent.click(commands);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(buttonRef.current).toBe(commands);
    expect(useStore.getState().activePanel).toBeNull();
  });
});
