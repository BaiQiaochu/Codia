import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
}

function cssBlock(css: string, selector: string): string {
  return css.match(new RegExp(`${selector}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

function sessionItemBlock(source: string) {
  const start = source.indexOf('const SessionItem = memo');
  const end = source.indexOf('interface SessionSummaryResponse', start);
  return source.slice(start, end);
}

describe('session delete entry', () => {
  it('keeps delete available from the row and the context menu', () => {
    const source = read('components/SessionList.tsx');
    expect(source).toContain("aria-label={t('session.delete')}");
    expect(source).toContain('className={styles.sessionDeleteBtn}');
    expect(source).toContain("label: t('session.delete')");
    expect(source).toContain('void deleteSession(session.path)');
  });

  it('uses a semantic row button without nesting row actions', () => {
    const block = sessionItemBlock(read('components/SessionList.tsx'));

    expect(block).toContain('<button');
    expect(block).toContain('type="button"');
    expect(block).not.toContain('<div\n        role="button"');

    const rowCloseIndex = block.indexOf('{rowBody}\n          </button>');
    expect(rowCloseIndex).toBeGreaterThan(-1);
    expect(rowCloseIndex).toBeLessThan(block.indexOf('className={styles.sessionPinBtn}'));
    expect(rowCloseIndex).toBeLessThan(block.indexOf('className={styles.sessionRenameBtn}'));
    expect(rowCloseIndex).toBeLessThan(block.indexOf('className={styles.sessionArchiveBtn}'));
    expect(rowCloseIndex).toBeLessThan(block.indexOf('className={styles.sessionDeleteBtn}'));
  });

  it('shows only the session title without a metadata subtitle', () => {
    const block = sessionItemBlock(read('components/SessionList.tsx'));
    expect(block).toContain('className={styles.sessionItemTitle}');
    expect(block).toContain('{displayTitle}');
    expect(block).not.toContain('styles.sessionItemMeta');
    expect(block).not.toContain("parts.join(");
  });

  it('does not hide the row delete control by default', () => {
    const css = read('components/SessionList.module.css');
    const deleteBlock = cssBlock(css, String.raw`\.sessionDeleteBtn`);

    expect(deleteBlock).toMatch(/opacity:\s*0\.72/);
    expect(deleteBlock).toMatch(/pointer-events:\s*auto/);
    expect(deleteBlock).not.toMatch(/opacity:\s*0\s*;/);
    expect(deleteBlock).not.toMatch(/pointer-events:\s*none/);
  });
});
