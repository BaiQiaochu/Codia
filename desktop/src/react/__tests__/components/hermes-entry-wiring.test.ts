import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Hermes removal wiring', () => {
  it('keeps the chat input free of the removed Hermes entry button', () => {
    const inputArea = read('components/InputArea.tsx');
    const styles = read('components/input/InputArea.module.css');
    const slashCommands = read('components/input/slash-commands.ts');

    expect(inputArea).not.toContain('buildHermesDraftText');
    expect(inputArea).not.toContain('handleHermesEntry');
    expect(inputArea).not.toContain('input.hermesEntry');
    expect(inputArea).not.toContain("styles['hermes-entry-btn']");
    expect(styles).not.toContain('hermes-entry');
    expect(slashCommands).not.toContain('hermes_agent');
  });
});
