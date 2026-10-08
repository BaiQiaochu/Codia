// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('AttachedFilesBar', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders image thumbnails for prepared image attachments and keeps normal file chips', async () => {
    const onRemove = vi.fn();
    const { AttachedFilesBar } = await import('../../components/input/AttachedFilesBar');

    const { container } = render(
      <AttachedFilesBar
        files={[
          {
            path: 'E:/images/sample.png',
            name: 'sample.png',
            base64Data: 'ZmFrZQ==',
            mimeType: 'image/png',
          },
          {
            path: 'E:/docs/readme.md',
            name: 'readme.md',
          },
        ]}
        onRemove={onRemove}
      />,
    );

    const image = container.querySelector('img');
    expect(image).toBeTruthy();
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,ZmFrZQ==');
    expect(screen.getByText('readme.md')).toBeTruthy();

    const removeButtons = screen.getAllByRole('button');
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
