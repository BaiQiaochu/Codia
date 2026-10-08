import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

describe('DeskTree markdown screenshot share wiring', () => {
  it('wires local markdown files to the screenshot share action', () => {
    const source = fs.readFileSync(path.join(ROOT, 'components/desk/DeskTree.tsx'), 'utf8');

    expect(source).toContain('takeMarkdownFileScreenshot');
    expect(source).toContain('isMarkdownFileName');
    expect(source).toContain("t('common.screenshotShare')");
    expect(source).toContain('fileName: file.name');
  });
});
