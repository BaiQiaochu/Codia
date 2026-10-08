import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('workflow step UI contract', () => {
  it('renders workflow steps in right workspace and inline cards', () => {
    const workflowCard = read('components/right-workspace/WorkflowCard.tsx');
    const inlineCard = read('components/chat/WorkflowInlineCard.tsx');
    const dots = read('components/shared/WorkflowProgressDots.tsx');

    expect(workflowCard).toContain("activity.kind === 'workflow_step'");
    expect(workflowCard).toContain('PhaseSection');
    expect(workflowCard).toContain('stepKind');
    expect(inlineCard).toContain('WorkflowProgressDots');
    expect(dots).toContain("node.kind === 'workflow_step'");
  });
});
