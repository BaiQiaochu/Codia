import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('preview editor context menu integration', () => {
  it('mounts markdown editor context menu only through PreviewPanel', () => {
    const panel = read('desktop/src/react/components/PreviewPanel.tsx');

    expect(panel).toContain("import { EditorContextMenu } from './preview/EditorContextMenu';");
    expect(panel).toContain("<EditorContextMenu editorRef={editorRef} containerRef={previewBodyRef} />");
  });

  it('provides markdown formatting commands for CodeMirror', () => {
    const commands = read('desktop/src/react/editor/markdown-commands.ts');

    expect(commands).toContain('export function toggleBold');
    expect(commands).toContain('export function toggleItalic');
    expect(commands).toContain('export function setHeading');
    expect(commands).toContain('export function insertCodeBlock');
    expect(commands).toContain('Transaction.userEvent.of');
  });
});
