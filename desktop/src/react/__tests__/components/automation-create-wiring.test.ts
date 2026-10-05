import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('automation create wiring', () => {
  it('the reusable automation jobs section includes the manual cron creation flow', () => {
    const panel = read('components/AutomationPanel.tsx');
    const source = read('components/automation/AutomationJobsSection.tsx');

    expect(panel).toContain('<AutomationJobsSection />');
    expect(source).toContain("action: 'add'");
    expect(source).toContain("scheduleType: 'cron'");
    expect(source).toContain("schedule: '0 9 * * *'");
    expect(source).toContain("enabled: false");
    expect(source).toContain('actorAgentId');
    expect(source).toContain('executionContext');
    expect(source).toContain("createdBy: { kind: 'user' }");
    expect(source).toContain('setOpenJobs');
    expect(source).toContain("t('automation.add')");
    expect(source).toContain('!response.ok');
    expect(source).toContain("typeof data.error === 'string'");
    expect(source).toContain("addToast(error instanceof Error ? error.message : fallbackMessage, 'error')");
  });
});
