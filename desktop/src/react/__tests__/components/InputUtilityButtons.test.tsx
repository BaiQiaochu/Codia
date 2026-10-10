// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React, { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputUtilityButtons } from '../../components/input/InputUtilityButtons';

const t = (key: string) => ({
  'input.addMenu': '添加',
}[key] || key);

describe('InputUtilityButtons', () => {
  afterEach(cleanup);

  it('opens the composer add menu from the four-point star button', () => {
    const onToggle = vi.fn();
    const buttonRef = createRef<HTMLButtonElement>();
    render(<InputUtilityButtons t={t} addMenu={{ open: true, onToggle, buttonRef }} />);
    const add = screen.getByRole('button', { name: '添加' });
    fireEvent.click(add);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(buttonRef.current).toBe(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
  });

  it('uses the outlined four-point star glyph', () => {
    const addMenu = { open: false, onToggle: vi.fn(), buttonRef: createRef<HTMLButtonElement>() };
    const { container } = render(<InputUtilityButtons t={t} addMenu={addMenu} />);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument();
  });
});
