// @ts-nocheck
/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  CardShell,
  EmptyState,
  CodiaThemeProvider,
  IconButton,
  List,
  Select,
  SettingRow,
  Switch,
  Textarea,
  TextInput,
} from '@codia/plugin-components';

describe('plugin component SDK', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders plugin surfaces that inherit Codia theme variables by default', () => {
    render(
      <CodiaThemeProvider>
        <CardShell title="工具结果">正文</CardShell>
      </CodiaThemeProvider>,
    );

    const root = screen.getByTestId('codia-plugin-theme');
    expect(root).toHaveClass('codia-plugin-theme');
    expect(root).toHaveAttribute('data-codia-theme-mode', 'inherit');
    expect(root).not.toHaveAttribute('data-codia-theme');
    expect(screen.getByText('工具结果')).toHaveClass('codia-plugin-card-title');
    expect(screen.getByText('正文')).toBeInTheDocument();
  });

  it('applies named and custom theme tokens while leaving unspecified tokens to CSS fallback', () => {
    const { rerender } = render(
      <CodiaThemeProvider mode="codia" theme="midnight">
        <span>named</span>
      </CodiaThemeProvider>,
    );

    let root = screen.getByTestId('codia-plugin-theme');
    expect(root).toHaveAttribute('data-codia-theme-mode', 'codia');
    expect(root).toHaveAttribute('data-codia-theme', 'midnight');
    expect(root).toHaveStyle({
      '--codia-plugin-bg': '#3B4A54',
      '--codia-plugin-accent': '#C99AAF',
    });

    rerender(
      <CodiaThemeProvider mode="custom" theme={{ bg: '#111111', accent: '#88AAFF' }}>
        <span>custom</span>
      </CodiaThemeProvider>,
    );

    root = screen.getByTestId('codia-plugin-theme');
    expect(root).toHaveAttribute('data-codia-theme-mode', 'custom');
    expect(root).toHaveStyle({
      '--codia-plugin-bg': '#111111',
      '--codia-plugin-accent': '#88AAFF',
    });
    expect(root.style.getPropertyValue('--codia-plugin-text')).toBe('');
  });

  it('renders controlled controls with stable Codia component classes', () => {
    const onButtonClick = vi.fn();
    const onTextChange = vi.fn();
    const onSwitchChange = vi.fn();

    render(
      <>
        <Button variant="primary" iconLeft={<span data-testid="button-icon" />} onClick={onButtonClick}>
          保存
        </Button>
        <IconButton label="刷新" onClick={onButtonClick}>
          R
        </IconButton>
        <TextInput label="名称" value="codia" onChange={onTextChange} />
        <Textarea label="备注" value="notes" onChange={onTextChange} />
        <Switch checked={false} onChange={onSwitchChange} label="启用" />
      </>,
    );

    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toHaveClass('codia-plugin-button', 'codia-plugin-button-primary');
    fireEvent.click(button);
    expect(onButtonClick).toHaveBeenCalledTimes(1);

    expect(screen.getByRole('button', { name: '刷新' })).toHaveClass('codia-plugin-icon-button');
    expect(screen.getByLabelText('名称')).toHaveClass('codia-plugin-input');
    expect(screen.getByLabelText('备注')).toHaveClass('codia-plugin-textarea');

    const toggle = screen.getByRole('switch', { name: '启用' });
    expect(toggle).toHaveClass('codia-plugin-switch');
    fireEvent.click(toggle);
    expect(onSwitchChange).toHaveBeenCalledWith(true);
  });

  it('uses a custom listbox select instead of native select', () => {
    const onChange = vi.fn();
    render(
      <Select
        label="模式"
        value="read"
        onChange={onChange}
        options={[
          { value: 'read', label: '阅读' },
          { value: 'write', label: '写作' },
        ]}
      />,
    );

    expect(document.querySelector('select')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '模式 阅读' }));
    expect(screen.getByRole('listbox', { name: '模式' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '写作' }));

    expect(onChange).toHaveBeenCalledWith('write');
  });

  it('renders layout primitives for repeated plugin UI patterns', () => {
    render(
      <CardShell title="同步" footer={<Button size="sm">重试</Button>}>
        <SettingRow label="目标" hint="会跟随当前 session" control={<Switch checked label="启用同步" />} />
        <List
          items={[
            { id: 'a', title: '第一项', meta: '已完成' },
            { id: 'b', title: '第二项', description: '等待处理' },
          ]}
        />
        <EmptyState title="暂无结果" description="运行后会显示在这里" />
      </CardShell>,
    );

    expect(screen.getByText('同步')).toHaveClass('codia-plugin-card-title');
    expect(screen.getByText('目标')).toHaveClass('codia-plugin-setting-label');
    expect(screen.getByText('第一项')).toHaveClass('codia-plugin-list-title');
    expect(screen.getByText('暂无结果')).toHaveClass('codia-plugin-empty-title');
  });
});
