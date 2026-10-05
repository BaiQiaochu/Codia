import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const localeFiles = ['en', 'zh', 'zh-TW', 'ja', 'ko'].map(locale =>
  path.join(repoRoot, 'desktop', 'src', 'locales', `${locale}.json`),
);

describe('onboarding debranding', () => {
  it('keeps first-run visible copy free of legacy product and persona names', () => {
    for (const filePath of localeFiles) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const onboardingCopy = JSON.stringify(data.onboarding);
      expect(onboardingCopy).not.toMatch(/Hana|Hanako|Butter|Kong|Ming|Hermes|OH-WorkSpace/i);
    }
  });

  it('uses a neutral browser title for the setup window', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'desktop', 'src', 'onboarding.html'), 'utf8');
    expect(html).toContain('<title>Setup</title>');
  });
});
