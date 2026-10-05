import { describe, it, expect } from 'vitest';
import { buildThemeName, extractScreenshotPayload } from '../desktop/src/react/utils/screenshot-extract';

describe('buildThemeName', () => {
  it('maps legacy light mobile to the G-SAP brand theme', () => {
    expect(buildThemeName('light', 'mobile')).toBe('gsap-brand');
  });
  it('maps legacy light desktop to the G-SAP brand desktop theme', () => {
    expect(buildThemeName('light', 'desktop')).toBe('gsap-brand-desktop');
  });
  it('maps legacy dark mobile to the G-SAP brand theme', () => {
    expect(buildThemeName('dark', 'mobile')).toBe('gsap-brand');
  });
  it('maps legacy dark desktop to the G-SAP brand desktop theme', () => {
    expect(buildThemeName('dark', 'desktop')).toBe('gsap-brand-desktop');
  });
  it('maps G-SAP brand mobile to gsap-brand', () => {
    expect(buildThemeName('gsap', 'mobile')).toBe('gsap-brand');
  });
  it('maps G-SAP brand desktop to gsap-brand-desktop', () => {
    expect(buildThemeName('gsap', 'desktop')).toBe('gsap-brand-desktop');
  });
  it('keeps the old sakura storage value on the G-SAP brand theme', () => {
    expect(buildThemeName('sakura', 'mobile')).toBe('gsap-brand');
  });
});

describe('extractScreenshotPayload', () => {
  it('uses article mode for a single assistant role and converts text blocks to html', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<h1>Hello</h1>' }] },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.mode).toBe('article');
    expect(result.messages).toHaveLength(1);
    expect(result.messages![0].blocks[0]).toEqual({ type: 'html', content: '<h1>Hello</h1>' });
  });

  it('uses article mode for a single user role and converts text to markdown', () => {
    const messages = [
      { id: '1', role: 'user' as const, text: '# Hello' },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.mode).toBe('article');
    expect(result.messages![0].blocks[0]).toEqual({ type: 'markdown', content: '# Hello' });
  });

  it('uses conversation mode when user and assistant messages are mixed', () => {
    const messages = [
      { id: '1', role: 'user' as const, text: 'hello' },
      { id: '2', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>hello</p>' }] },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-dark');

    expect(result.mode).toBe('conversation');
    expect(result.messages).toHaveLength(2);
    expect(result.messages![0].blocks[0].type).toBe('markdown');
    expect(result.messages![1].blocks[0].type).toBe('html');
  });

  it('filters out thinking, mood, and tool blocks', () => {
    const messages = [
      {
        id: '1',
        role: 'assistant' as const,
        blocks: [
          { type: 'thinking' as const, content: '...', sealed: true },
          { type: 'mood' as const, yuan: 'gsap', text: 'happy' },
          { type: 'tool_group' as const, tools: [] as any[], collapsed: true },
          { type: 'text' as const, html: '<p>visible</p>' },
        ],
      },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.messages![0].blocks).toHaveLength(1);
    expect(result.messages![0].blocks[0]).toEqual({ type: 'html', content: '<p>visible</p>' });
  });

  it('keeps assistant image file blocks', () => {
    const messages = [
      {
        id: '1',
        role: 'assistant' as const,
        blocks: [
          { type: 'text' as const, html: '<p>text</p>' },
          { type: 'file' as const, filePath: '/tmp/img.png', label: 'img', ext: 'png' },
        ],
      },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.messages![0].blocks).toHaveLength(2);
    expect(result.messages![0].blocks[1]).toEqual({ type: 'image', content: '/tmp/img.png' });
  });

  it('drops non-image assistant file blocks', () => {
    const messages = [
      {
        id: '1',
        role: 'assistant' as const,
        blocks: [
          { type: 'text' as const, html: '<p>code</p>' },
          { type: 'file' as const, filePath: '/tmp/file.py', label: 'file', ext: 'py' },
        ],
      },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.messages![0].blocks).toHaveLength(1);
    expect(result.messages![0].blocks[0].type).toBe('html');
  });

  it('keeps assistant screenshot image blocks as data URLs', () => {
    const messages = [
      {
        id: '1',
        role: 'assistant' as const,
        blocks: [
          { type: 'screenshot' as const, base64: 'ABC123', mimeType: 'image/png' },
        ],
      },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.messages![0].blocks).toEqual([
      { type: 'image', content: 'data:image/png;base64,ABC123' },
    ]);
  });

  it('keeps user image attachments from cached base64 and file paths', () => {
    const messages = [
      {
        id: '1',
        role: 'user' as const,
        text: 'see these',
        attachments: [
          {
            path: '/tmp/a.png',
            name: 'a.png',
            isDir: false,
            mimeType: 'image/png',
            base64Data: 'AAA',
          },
          {
            path: '/tmp/b.svg',
            name: 'b.svg',
            isDir: false,
            mimeType: 'image/svg+xml',
          },
          {
            path: '/tmp/readme.md',
            name: 'readme.md',
            isDir: false,
            mimeType: 'text/markdown',
          },
        ],
      },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.messages![0].blocks).toEqual([
      { type: 'markdown', content: 'see these' },
      { type: 'image', content: 'data:image/png;base64,AAA' },
      { type: 'image', content: '/tmp/b.svg' },
    ]);
  });

  it('returns article mode with an empty messages array for empty input', () => {
    const result = extractScreenshotPayload([], 'solarized-light');

    expect(result.mode).toBe('article');
    expect(result.messages).toHaveLength(0);
  });

  it('returns no user blocks when a user message has no text or attachments', () => {
    const messages = [{ id: '1', role: 'user' as const }];

    const result = extractScreenshotPayload(messages as any, 'solarized-light');

    expect(result.messages![0].blocks).toHaveLength(0);
  });
});
