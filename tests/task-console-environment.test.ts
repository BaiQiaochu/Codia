import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { diagnoseTemplateEnvironment } from '../server/routes/task-console-environment.ts';
import { createTaskConsoleRoute } from '../server/routes/task-console.ts';
import { TASK_TEMPLATES, buildTemplatePlan } from '../shared/task-console/templates.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-preflight-')); dirs.push(root);
  const scope = path.join(root, 'workspace'); fs.mkdirSync(scope);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const invoke = vi.fn();
  const state = { enabled: true, connectors: [{ id: 'source', status: 'running', headers: { Authorization: 'secret' } }] };
  const tool = { name: 'mcp_source_read', _pluginId: 'mcp', metadata: { kind: 'mcp', connectorId: 'source' }, isEnabledForAgentConfig: () => true, execute: invoke };
  const engine = { agent: { id: 'a', agentDir: root, config: {}, tools: ['read', 'write', 'bash', 'edit', 'web_fetch', 'web_search'].map(name => ({ name, execute: invoke })) },
    currentModel: { id: 'model', toolCalling: true, cost: { input: 1, output: 1 } },
    getSessionFolderScope: () => ({ sandboxFolders: [scope] }), pluginManager: { getAllTools: () => [tool], getPlugin: () => ({ ctx: { _mcpRuntime: { getState: () => state } } }) } };
  return { root, scope, outside, engine, tool, state, invoke };
}
describe('actual template environment inspection', () => {
  it('checks registered authorized tools and existing MCP liveness without invoking tools or exposing secrets', () => {
    const f = fixture();
    const result = diagnoseTemplateEnvironment(f.engine, TASK_TEMPLATES[0], {}, { workspace: f.scope, connectorTools: ['mcp_source_read'] });
    expect(result.tools.state).toBe('pass'); expect(result.directory.state).toBe('pass');
    expect(result.tools.checks.at(-1)).toMatchObject({ connection: 'running', state: 'pass' });
    expect(JSON.stringify(result)).not.toContain('secret'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('fails disconnected and unauthorized connectors and missing tool names', () => {
    const f = fixture(); const check = () => diagnoseTemplateEnvironment(f.engine, TASK_TEMPLATES[0], {}, { connectorTools: ['mcp_source_read'] });
    f.state.connectors[0].status = 'reconnecting'; expect(check().tools.state).toBe('fail');
    f.state.connectors[0].status = 'running'; f.tool.isEnabledForAgentConfig = () => false; expect(check().tools.state).toBe('fail');
    expect(diagnoseTemplateEnvironment(f.engine, TASK_TEMPLATES[0], {}, { connectorTools: ['invented'] }).tools.state).toBe('fail');
  });
  it('never treats a missing runtime registry or scope as verified', () => {
    const result = diagnoseTemplateEnvironment({}, TASK_TEMPLATES[0], {}, { workspace: '/tmp' });
    expect(result.tools.state).toBe('unknown'); expect(result.directory.state).toBe('unknown');
  });
  it('rejects symlink escapes, sibling prefix directories, nonexistent targets and files', () => {
    const f = fixture(); fs.symlinkSync(f.outside, path.join(f.scope, 'escape')); fs.writeFileSync(path.join(f.scope, 'file'), 'data');
    fs.mkdirSync(path.join(f.root, 'workspace-other'));
    for (const workspace of [path.join(f.scope, 'escape'), path.join(f.root, 'workspace-other'), path.join(f.scope, 'missing'), path.join(f.scope, 'file'), '../relative']) {
      expect(diagnoseTemplateEnvironment(f.engine, TASK_TEMPLATES[0], {}, { workspace }).directory.state).toBe('fail');
    }
  });
  it('uses the repository project path rather than an unrelated approved output path', () => {
    const f = fixture();
    expect(diagnoseTemplateEnvironment(f.engine, TASK_TEMPLATES[1], { 项目目录: f.outside }, { workspace: f.scope }).directory.state).toBe('fail');
  });
  it('returns immutable ordered exact-version plans', () => {
    for (const template of TASK_TEMPLATES) {
      const plan = buildTemplatePlan(template, {});
      expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.steps[0])).toBe(true);
      expect(plan.version).toBe(template.version); expect(plan.steps[0].dependsOn).toBeNull();
      expect(plan.steps[1].dependsOn).toBe(plan.steps[0].id);
    }
  });
  it('blocks execution on recomputed model qualification even with forged passing flags', async () => {
    const f = fixture(); const app = new Hono().route('/api', createTaskConsoleRoute(f.engine, {}));
    const response = await app.request('/api/task-console/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmExperimental: true, requestId: 'forged-flags-test', templateId: 'research-brief', version: '1.0.0', inputs: { 主题: 'Topic', 范围: 'Scope', 截止时间: 'Today' }, workspace: f.scope, budget: { maxTokens: 100, maxUsd: 1 }, ready: true, executionAllowed: true, evidence: { model: 'pass' } }) });
    expect(response.status).toBe(409);
    const result = await response.json(); expect(result.executionAllowed).toBe(false);
    expect(result.checks.find((check: any) => check.id === 'model').state).toBe('unknown'); expect(f.invoke).not.toHaveBeenCalled();
  });
});
