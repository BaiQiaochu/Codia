// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const screenshotMock = vi.hoisted(() => ({
  takeMarkdownFileScreenshot: vi.fn(async () => undefined),
}));

vi.mock('../../utils/screenshot', () => screenshotMock);

import { FileOutputActions } from '../../components/chat/FileOutputActions';

describe('FileOutputActions markdown screenshot share', () => {
  beforeEach(() => {
    screenshotMock.takeMarkdownFileScreenshot.mockClear();
    window.t = (key: string) => {
      if (key === 'common.screenshotShare') return 'Screenshot share';
      if (key === 'chat.fileActions.more') return 'More file actions';
      return key;
    };
  });

  afterEach(() => {
    cleanup();
    delete window.t;
  });

  it('offers screenshot share for staged markdown outputs using the display name', () => {
    render(<FileOutputActions filePath="/tmp/session-files/a1b2c3" displayName="report.md" />);

    fireEvent.click(screen.getByRole('button', { name: /More file actions report\.md/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Screenshot share/i }));

    expect(screenshotMock.takeMarkdownFileScreenshot).toHaveBeenCalledWith(
      '/tmp/session-files/a1b2c3',
      { fileName: 'report.md' },
    );
  });

  it('does not offer screenshot share for non-markdown outputs', () => {
    render(<FileOutputActions filePath="/tmp/session-files/image" displayName="image.png" />);

    fireEvent.click(screen.getByRole('button', { name: /More file actions image\.png/i }));

    expect(screen.queryByRole('menuitem', { name: /Screenshot share/i })).toBeNull();
  });
});
