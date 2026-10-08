import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../..');

describe('agent memory settings cleanup', () => {
  it('does not ship the legacy memory import/export dropdown', () => {
    const agentMemory = fs.readFileSync(
      path.join(repoRoot, 'desktop/src/react/settings/tabs/agent/AgentMemory.tsx'),
      'utf-8',
    );
    const agentTab = fs.readFileSync(
      path.join(repoRoot, 'desktop/src/react/settings/tabs/AgentTab.tsx'),
      'utf-8',
    );
    const settingsCss = fs.readFileSync(
      path.join(repoRoot, 'desktop/src/react/settings/Settings.module.css'),
      'utf-8',
    );

    expect(agentMemory).not.toContain('MemoryMoreDropdown');
    expect(agentMemory).not.toContain('/api/memories/export');
    expect(agentMemory).not.toContain('/api/memories/import');
    expect(agentMemory).not.toContain('settings.memory.actions.export');
    expect(agentMemory).not.toContain('settings.memory.actions.import');
    expect(agentMemory).not.toContain('isViewingOther');
    expect(agentTab).not.toContain('isViewingOther');
    expect(settingsCss).not.toContain('memory-action-dropdown');
    expect(settingsCss).not.toContain('memory-more-popup');
  });
});
