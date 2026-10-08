import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Hermes tool removal wiring', () => {
  it('does not expose Hermes as an agent tool, skill notice, or Yuan template', () => {
    const skillsTab = read('settings/tabs/SkillsTab.tsx');
    const agentTools = read('settings/tabs/agent/AgentToolsSection.tsx');
    const yuanRegistry = read('../../../core/yuan-registry.ts');

    expect(skillsTab).not.toContain('hermesBuiltInTitle');
    expect(agentTools).not.toContain('hermes_agent');
    expect(yuanRegistry).toContain('template not found in lib/yuan');

    for (const locale of ['zh', 'zh-TW', 'en', 'ja', 'ko']) {
      const data = JSON.parse(read(`../locales/${locale}.json`));
      expect(data.yuan?.types?.hermes).toBeUndefined();
      expect(JSON.stringify(data.settings?.agent?.tools || {})).not.toContain('hermes_agent');
    }
  });
});
