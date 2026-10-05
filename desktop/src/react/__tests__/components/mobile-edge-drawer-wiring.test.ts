import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('mobile edge drawer wiring', () => {
  it('wires narrow viewport edge swipes to the existing left and right drawers', () => {
    const app = read('App.tsx');
    const css = read('../../src/styles.css');

    expect(app).toContain('startMobileEdgeGesture');
    expect(app).toContain('finishMobileEdgeGesture');
    expect(app).toContain('handleMobileEdgeTouchStart');
    expect(app).toContain('handleMobileEdgeTouchMove');
    expect(app).toContain('handleMobileEdgeTouchEnd');
    expect(app).toContain('toggleSidebar(true)');
    expect(app).toContain('toggleJianSidebar(true)');
    expect(app).toMatch(/className="app"[\s\S]*onTouchStart=\{handleMobileEdgeTouchStart\}/);
    expect(app).toMatch(/className="app"[\s\S]*onTouchMove=\{handleMobileEdgeTouchMove\}/);
    expect(app).toMatch(/className="app"[\s\S]*onTouchEnd=\{handleMobileEdgeTouchEnd\}/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.app\s*\{[\s\S]*touch-action:\s*pan-y;/);
  });
});
