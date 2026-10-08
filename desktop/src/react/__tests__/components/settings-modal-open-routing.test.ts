import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('settings modal open routing', () => {
  it('routes main-window settings requests to the in-app modal to avoid stacked settings windows', () => {
    const appInit = read('app-init.ts');
    const floatPreview = read('components/FloatPreviewCard.tsx');

    expect(appInit).toContain("import { openSettingsModal } from './stores/settings-modal-actions';");
    expect(appInit).toContain('openSettingsModal(tab);');
    expect(appInit).toContain('openSettingsModal();');
    expect(appInit).not.toContain('window.platform.openSettings(tab);');
    expect(appInit).not.toContain('platform.openSettings();');
    expect(floatPreview).toContain("import { openSettingsModal } from '../stores/settings-modal-actions';");
    expect(floatPreview).toContain('openSettingsModal();');
    expect(floatPreview).not.toContain('window.platform?.openSettings();');
  });
});
