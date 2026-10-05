import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('App session identity key contract', () => {
  it('keys session-scoped chat and input surfaces by stable session id first', () => {
    const source = read('App.tsx');

    expect(source).toContain('const currentSessionId = useStore(s => s.currentSessionId);');
    expect(source).toContain("const currentSessionIdentityKey = currentSessionId || currentSessionPath || '__new';");
    expect(source).toContain('resetKeys={[currentSessionIdentityKey]}');
    expect(source).toContain('key={currentSessionIdentityKey}');
  });

  it('does not replace the whole chat transcript with a generic region fallback', () => {
    const source = read('App.tsx');

    expect(source).toContain('function CriticalRegionFallback');
    const chatRegionIndex = source.indexOf('region="chat"');
    const chatBoundaryStart = source.lastIndexOf('<RegionalErrorBoundary', chatRegionIndex);
    const chatBoundaryEnd = source.indexOf('</RegionalErrorBoundary>', chatRegionIndex);
    const chatBoundary = source.slice(chatBoundaryStart, chatBoundaryEnd);
    expect(chatBoundary).toContain('region="chat"');
    expect(chatBoundary).not.toContain('fallback={');
    expect(source).toMatch(/<RegionalErrorBoundary[\s\S]*region="input"[\s\S]*fallback=\{/);
  });
});
