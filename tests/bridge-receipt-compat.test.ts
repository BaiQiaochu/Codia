import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('bridge receipt compatibility source', () => {
  it('keeps the legacy waiting receipt shim as a clean wrapper', () => {
    const source = fs.readFileSync(path.join(root, 'lib/bridge/bridge-manager.ts'), 'utf8');
    const start = source.indexOf('_sendLlmWaitingReceipt(');
    const end = source.indexOf('\n\n  /**', start);
    const method = start >= 0 && end > start ? source.slice(start, end) : '';

    expect(method).toContain('_startLlmWaitingReceipt');
    expect(method).not.toContain('锛');
    expect(method).not.toContain('姝');
    expect(method).not.toMatch(/return;\s*if \(/);
  });
});
