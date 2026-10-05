import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');

function read(relative: string) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

describe('desk mind map menu wiring', () => {
  it('exposes new mind map creation from blank desk context menus', () => {
    const fileList = read('components/desk/DeskFileList.tsx');
    const dropZone = read('components/desk/DeskDropZone.tsx');

    expect(fileList).toContain('deskCreateMindmap');
    expect(fileList).toContain("tFn('desk.ctx.newMindmap')");
    expect(dropZone).toContain('deskCreateMindmap');
    expect(dropZone).toContain("tFn('desk.ctx.newMindmap')");
  });

  it('exposes document-to-mindmap creation from file context menus', () => {
    const fileItem = read('components/desk/DeskFileItem.tsx');
    const tree = read('components/desk/DeskTree.tsx');

    expect(fileItem).toContain('deskCreateMindmapFromDocument');
    expect(fileItem).toContain("tFn('desk.ctx.createMindmapFromDocument')");
    expect(tree).toContain('deskCreateMindmapFromDocument');
    expect(tree).toContain("t('desk.ctx.createMindmapFromDocument')");
  });

  it('hides local file-manager actions from the web runtime', () => {
    const toolbar = read('components/desk/DeskToolbar.tsx');
    const dropZone = read('components/desk/DeskDropZone.tsx');
    const cwdSkills = read('components/desk/DeskCwdSkills.tsx');

    expect(toolbar).toContain("import { isWebRuntime } from '../../utils/platform-runtime'");
    expect(toolbar).toContain('const webRuntime = isWebRuntime();');
    expect(toolbar).toContain('if (webRuntime || !hasNativeRoot) return null');
    expect(dropZone).toContain("...(!isWebRuntime() && canUseNativePath ? [");
    expect(cwdSkills).toContain("import { isWebRuntime } from '../../utils/platform-runtime'");
    expect(cwdSkills).toContain('{!isWebRuntime() && (');
  });
});
