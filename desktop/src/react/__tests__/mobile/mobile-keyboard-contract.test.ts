import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../..');

describe('mobile keyboard layout contract', () => {
  it('leaves keyboard viewport handling to browser-native dynamic viewport sizing', () => {
    const appSource = fs.readFileSync(
      path.join(repoRoot, 'desktop/src/react/mobile/MobileApp.tsx'),
      'utf-8',
    );
    const cssSource = fs.readFileSync(
      path.join(repoRoot, 'desktop/src/react/mobile/MobileApp.css'),
      'utf-8',
    );

    expect(cssSource).toContain('100dvh');
    expect(appSource).not.toContain('calculateInputCardBottomInset');
    expect(appSource).not.toContain('parseCssPixels');
    expect(appSource).not.toContain('useInputCardLayout');
    expect(appSource).not.toContain('--input-card-bottom-inset');
    expect(appSource).not.toContain('data-mobile-keyboard-open');
    expect(appSource).not.toContain('--mobile-layout-height');
    expect(appSource).not.toContain('--mobile-keyboard-offset');
  });
});
