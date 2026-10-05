import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('detached editor image context', () => {
  it('passes the current file path to markdown image resolution', () => {
    const source = read('editor-window-entry.ts');

    expect(source).toContain('markdownImageContext');
    expect(source).toContain('filePath');
    expect(source).toContain('getFileUrl');
    expect(source).not.toContain('loadEditorModeResources(mode),');
  });
});
