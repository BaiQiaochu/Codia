import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function readLocale(name: string) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${name}.json`), 'utf8'));
}

describe('settings tool localization', () => {
  it('has visible Chinese labels for all assistant optional tools', () => {
    const zh = readLocale('zh');
    const items = zh.settings.agent.tools.items;

    expect(items.automation).toMatchObject({
      label: '自动化',
      summary: expect.stringContaining('自动'),
    });
    expect(items.beautify).toMatchObject({
      label: '文档美化',
      summary: expect.stringContaining('封面'),
    });
    expect(items.workflow).toMatchObject({
      label: '工作流',
      summary: expect.stringContaining('多智能体'),
    });
  });
});
