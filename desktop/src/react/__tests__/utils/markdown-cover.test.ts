import { describe, expect, it } from 'vitest';
import {
  findMarkdownCoverRenderRange,
  isMarkdownCoverOnlyUpdate,
  mergeMarkdownCoverIntoDocument,
  parseMarkdownCover,
  removeMarkdownCover,
  resolveMarkdownCoverImagePath,
  stripMarkdownFrontMatterForPreview,
  updateMarkdownCoverLayout,
} from '../../utils/markdown-cover';

describe('markdown cover utilities', () => {
  it('parses cover metadata and strips frontmatter from preview markdown', () => {
    const markdown = [
      '---',
      'title: Demo',
      'cover:',
      '  image: 文本附件/cover.png',
      '  actualRatio: 3:2',
      '  displayHeight: 360',
      '  positionX: 50',
      '  positionY: 42',
      '---',
      '# Demo',
      '',
      'Body',
    ].join('\n');

    expect(parseMarkdownCover(markdown)).toMatchObject({
      image: '文本附件/cover.png',
      actualRatio: '3:2',
      displayHeight: 360,
      positionX: 50,
      positionY: 42,
    });
    expect(stripMarkdownFrontMatterForPreview(markdown)).toBe('# Demo\n\nBody');
  });

  it('updates layout fields while preserving presentation metadata and removing deprecated generation metadata', () => {
    const markdown = [
      '---',
      'title: Demo',
      'cover:',
      '  image: 文本附件/cover.png',
      '  prompt: hidden generation prompt',
      '  promptPreset: modern-anime-paper-key-visual',
      '  preferredRatio: 3:2',
      '  actualRatio: 3:2',
      '  generatedAt: 2026-05-26T10:11:12.000Z',
      '  generator:',
      '    provider: openai',
      '    model: gpt-image-2',
      '  positionY: 42',
      'tags:',
      '  - writing',
      '---',
      '# Demo',
    ].join('\n');

    const next = updateMarkdownCoverLayout(markdown, {
      displayHeight: 420,
      positionX: 50,
      positionY: 64,
      displayWidth: 100,
    });

    expect(next).toContain('title: Demo');
    expect(next).toContain('tags:\n  - writing');
    expect(next).toContain('image: 文本附件/cover.png');
    expect(next).toContain('actualRatio: 3:2');
    expect(next).not.toContain('hidden generation prompt');
    expect(next).not.toContain('promptPreset:');
    expect(next).not.toContain('preferredRatio:');
    expect(next).not.toContain('generatedAt:');
    expect(next).not.toContain('generator:');
    expect(next).not.toContain('provider: openai');
    expect(next).toContain('displayHeight: 420');
    expect(next).toContain('positionX: 50');
    expect(next).toContain('positionY: 64');
    expect(next).toContain('displayWidth: 100');
    expect(next).toMatch(/\n---\n# Demo$/);
  });

  it('merges a cover-only external update into a dirty markdown document body', () => {
    const saved = [
      '---',
      'title: Demo',
      '---',
      '# Demo',
      '',
      'Body',
    ].join('\n');
    const coverUpdated = [
      '---',
      'title: Demo',
      'cover:',
      '  image: attachments/cover.png',
      '  displayHeight: 320',
      '---',
      '# Demo',
      '',
      'Body',
    ].join('\n');
    const dirty = [
      '---',
      'title: Demo',
      '---',
      '# Demo',
      '',
      'Body with local draft',
    ].join('\n');

    expect(isMarkdownCoverOnlyUpdate(saved, coverUpdated)).toBe(true);
    expect(mergeMarkdownCoverIntoDocument(dirty, coverUpdated)).toBe([
      '---',
      'title: Demo',
      'cover:',
      '  image: attachments/cover.png',
      '  displayHeight: 320',
      '---',
      '# Demo',
      '',
      'Body with local draft',
    ].join('\n'));
  });

  it('removes only the cover block while preserving other frontmatter fields', () => {
    const markdown = [
      '---',
      'title: Demo',
      'cover:',
      '  image: attachments/cover.png',
      '  displayHeight: 320',
      'tags:',
      '  - writing',
      '---',
      '# Demo',
    ].join('\n');

    expect(removeMarkdownCover(markdown)).toBe([
      '---',
      'title: Demo',
      'tags:',
      '  - writing',
      '---',
      '# Demo',
    ].join('\n'));
  });

  it('removes cover-only frontmatter together with the delimiters', () => {
    const markdown = [
      '---',
      'cover:',
      '  image: attachments/cover.png',
      '---',
      '# Demo',
    ].join('\n');

    expect(removeMarkdownCover(markdown)).toBe('# Demo');
  });

  it('renders only the cover block when other frontmatter fields exist', () => {
    const markdown = [
      '---',
      'title: Demo',
      'cover:',
      '  image: attachments/cover.png',
      'tags:',
      '  - writing',
      '---',
      '# Demo',
    ].join('\n');
    const range = findMarkdownCoverRenderRange(markdown);

    expect(range && markdown.slice(range.from, range.to)).toBe([
      'cover:',
      '  image: attachments/cover.png',
      '',
    ].join('\n'));
  });

  it('preserves Windows drive and UNC prefixes when resolving cover image paths', () => {
    expect(resolveMarkdownCoverImagePath('C:\\vault\\notes\\day.md', 'attachments\\cover.png'))
      .toBe('C:/vault/notes/attachments/cover.png');
    expect(resolveMarkdownCoverImagePath('\\\\server\\share\\notes\\day.md', 'attachments\\cover.png'))
      .toBe('//server/share/notes/attachments/cover.png');
    expect(resolveMarkdownCoverImagePath('/vault/notes/day.md', '../covers/cover.png'))
      .toBe('/vault/covers/cover.png');
  });
});
