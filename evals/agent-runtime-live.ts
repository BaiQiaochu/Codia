import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntimeFixture, type LiveRuntimeConfig } from './agent-runtime-fixture.ts';

/** Explicit opt-in smoke evaluation. Never read Codia's production configuration. */
export async function runLiveRuntimeCase(config: LiveRuntimeConfig) {
  const fixture = await createRuntimeFixture([], { modelCalls: 16, toolCalls: 64, activeMs: 300000 }, () => [], config);
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'sum.cjs'), 'module.exports=(a,b)=>a-b;\n');
    fs.writeFileSync(path.join(fixture.workspace, 'check.cjs'),
      "const assert=require('node:assert/strict');assert.equal(require('./sum.cjs')(2,3),5);console.log('PASS');");
    await fixture.session.prompt('Fix sum.cjs so it adds its two arguments. Run node check.cjs, repair failures, and write a brief change explanation to result.txt. Do not edit check.cjs.');
    let passed = fixture.control.snapshot()?.status === 'completed';
    const explanation = path.join(fixture.workspace, 'result.txt');
    passed &&= fs.existsSync(explanation) && fs.statSync(explanation).size > 0;
    // Independent checks outside the model's editable checker.
    try {
      const program = `const assert=require('node:assert/strict');const sum=require(${JSON.stringify(path.join(fixture.workspace, 'sum.cjs'))});assert.equal(sum(2,3),5);assert.equal(sum(-4,1),-3);`;
      execFileSync(process.execPath, ['-e', program], { cwd: fixture.workspace, timeout: 5000, windowsHide: true, stdio: 'pipe' });
    } catch { passed = false; }
    return [{ id: 'live-repair-project', status: passed ? 'passed' : 'failed', usage: fixture.control.snapshot()?.used }];
  } finally { await fixture.close(); }
}
