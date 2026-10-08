import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

describe('Source environment mappings preserve strict lint checks', () => {
  it('recognizes Node authoring scripts without allowing browser-only globals', async () => {
    const [result] = await eslint.lintText("console.log(Buffer.from(process.cwd())); document.title = 'wrong environment';", { filePath: 'design/codia/live2d/build-psd.mjs' });
    expect(result.messages.filter(message => message.ruleId === 'no-undef').map(message => message.message)).toEqual(["'document' is not defined."]);
  });
  it('recognizes the browser review surface without allowing Node-only globals', async () => {
    const [result] = await eslint.lintText("document.title = location.href; console.log(process.cwd());", { filePath: 'design/codia/live2d/preview/review.js' });
    expect(result.messages.filter(message => message.ruleId === 'no-undef').map(message => message.message)).toEqual(["'process' is not defined."]);
  });
  it('permits browser-evaluate callbacks only in explicitly named smoke scripts', async () => {
    for (const filePath of ['scripts/codia-layout-visual-qa.mjs', 'scripts/e2e-quick-action-review.mjs']) {
      const [result] = await eslint.lintText("console.log(process.cwd(), document.title, window.innerWidth); accidentalGlobal();", { filePath });
      expect(result.messages.filter(message => message.ruleId === 'no-undef').map(message => message.message)).toEqual(["'accidentalGlobal' is not defined."]);
    }
  });
  it('excludes exactly vendored or generated JS while checking owned integration source', async () => {
    for (const filePath of [
      'third_party/live2d/cubism-web-5-r.5/Core/live2dcubismcore.js',
      'desktop/src/assets/codia/live2d/core/live2dcubismcore.js',
      'desktop/src/assets/codia/live2d/framework.js',
      '.local-tools/live2d/react-fixture/assets/runtime-test.js',
    ]) expect(await eslint.isPathIgnored(filePath)).toBe(true);
    for (const filePath of [
      'third_party/live2d/framework-entry.ts',
      'scripts/prepare-codia-live2d.mjs',
      'scripts/fixtures/codia-live2d/app.tsx',
      'scripts/codia-live2d-native-fixture.mjs',
      'design/codia/live2d/build-psd.mjs',
      'desktop/src/react/components/CodiaLive2DMascot.tsx',
    ]) expect(await eslint.isPathIgnored(filePath)).toBe(false);
  });
});
