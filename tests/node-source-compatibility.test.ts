import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const runtimeDirectories = ['core', 'lib', 'server', 'shared', 'hub', 'cli', 'plugins'];
const excludedDirectories = new Set(['node_modules', 'vendor', 'dist']);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return excludedDirectories.has(entry.name) ? [] : sourceFiles(file);
    return entry.isFile() && file.endsWith('.ts') && !file.endsWith('.d.ts') ? [file] : [];
  });
}

describe('uncompiled Node server compatibility', () => {
  it('loads execution control in plain Node without a TypeScript transform loader', () => {
    const moduleUrl = pathToFileURL(path.join(root, 'lib/execution/run-controller.ts')).href;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { RunController } = await import(${JSON.stringify(moduleUrl)});
      const run = new RunController({ limits: { modelCalls: 2, toolCalls: 3, activeMs: 1000 } });
      run.begin();
      run.admitModel();
      run.cancel();
      const state = run.snapshot();
      if (state.status !== 'cancelled' || state.used.modelCalls !== 1 || state.limits.modelCalls !== 2) {
        throw new Error('Unexpected execution controller state');
      }
      console.log('source-import-ok');
    `], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('source-import-ok');
  });

  it('keeps server TypeScript erasable by the source launcher', () => {
    const files = runtimeDirectories.flatMap(directory => sourceFiles(path.join(root, directory)));
    const failures: string[] = [];
    for (const file of files) {
      try {
        stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
      } catch (error) {
        failures.push(`${path.relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(files.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
