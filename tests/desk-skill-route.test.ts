// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const extractZipMock = vi.fn(async (_zipPath, destDir) => {
  const skillDir = path.join(destDir, 'sample-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: sample-skill\n---\nbody', 'utf-8');
});

vi.mock('../lib/extract-zip.js', () => ({
  extractZip: (...args) => extractZipMock(...args),
}));

const { createDeskRoute } = await import('../server/routes/desk.js');

describe('desk skill route', () => {
  const tempRoots = [];

  afterEach(() => {
    extractZipMock.mockClear();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs zip skills with extractZip and syncs workspace skills', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-skill-route-'));
    tempRoots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const zipPath = path.join(root, 'sample-skill.zip');
    fs.writeFileSync(zipPath, 'fake zip payload');

    const engine = {
      currentAgentId: 'codia',
      getAgent: vi.fn(() => ({
        id: 'codia',
        cronStore: null,
        deskDir: workspace,
      })),
      deskCwd: workspace,
      homeCwd: workspace,
      syncWorkspaceSkillPaths: vi.fn(async () => {}),
    };

    const app = new Hono();
    app.route('/api', createDeskRoute(engine, { scheduler: {} }));

    const res = await app.request('/api/desk/install-skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: zipPath, dir: workspace }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe('sample-skill');
    expect(extractZipMock).toHaveBeenCalledTimes(1);
    expect(engine.syncWorkspaceSkillPaths).toHaveBeenCalledWith(workspace, expect.objectContaining({
      reload: true,
      emitEvent: true,
      force: true,
    }));
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'sample-skill', 'SKILL.md'))).toBe(true);
  });
});
