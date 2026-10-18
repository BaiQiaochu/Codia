import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { WorkflowJournal } from '../../lib/workflow/journal.ts';

/** Owner-only under the default route security policy. Never executes a workflow. */
export function createWorkflowRecoveryRoute(engine: any) {
  const route = new Hono();
  function find(runId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid workflow run ID');
    for (const info of engine.listAgents()) {
      const agent = engine.getAgent(info.id);
      if (!agent?.agentDir) continue;
      const dir = path.join(agent.agentDir, 'workflow-journals');
      const file = path.join(dir, `${runId}.jsonl`);
      if (!fs.existsSync(file)) continue;
      if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.join(fs.realpathSync(dir), `${runId}.jsonl`)) {
        throw new Error('Workflow journal path is unsafe');
      }
      return WorkflowJournal.load(file);
    }
    throw new Error('Workflow recovery journal is unavailable');
  }
  route.post('/workflow-runs/:runId/cancel', (c) => {
    const runId = c.req.param('runId');
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return c.json({ error: 'invalid_run_id' }, 400);
    for (const info of engine.listAgents()) {
      if (engine.getAgent(info.id)?.workflowTool?.cancelRun?.(runId)) {
        return c.json({ ok: true, note: '已请求停止后续步骤；进行中的外部操作可能已生效，请核对动作账本。' });
      }
    }
    return c.json({ error: 'run_not_active_in_this_process' }, 409);
  });
  route.get('/workflow-recovery/:runId', (c) => {
    try {
      const journal = find(c.req.param('runId'));
      return c.json({ runId: c.req.param('runId'), ...journal.inspectRecovery(), sessionPath: journal.metadata?.definition?.parentSessionPath || null });
    } catch (error) { return c.json({ error: String((error as Error).message) }, 404); }
  });
  route.post('/workflow-recovery/:runId/draft', (c) => {
    try {
      const runId = c.req.param('runId');
      const journal = find(runId);
      const inspection = journal.inspectRecovery();
      if (!inspection.canPrepare) return c.json({ error: inspection.blockedReason }, 409);
      const definition = journal.metadata.definition;
      const params = { script: definition.script, ...(definition.hasArgs ? { args: definition.args } : {}), resumeFromRunId: runId };
      return c.json({ sessionPath: definition.parentSessionPath, draft: `请在此原会话使用 workflow 工具恢复下面的既有运行，保持 script、args 和 resumeFromRunId 原样。先核对已有产物；结果未知的外部写入禁止重试；任何新权限仍走现有审批。不要改为创建全新运行。\n${JSON.stringify(params, null, 2)}` });
    } catch (error) { return c.json({ error: String((error as Error).message) }, 400); }
  });
  route.post('/workflow-recovery/:runId/cancel', (c) => {
    try {
      find(c.req.param('runId')).cancelRecovery();
      return c.json({ ok: true, note: '已放弃此检查点的后续恢复；不会撤销外部操作或终止其他运行。' });
    } catch (error) { return c.json({ error: String((error as Error).message) }, 400); }
  });
  return route;
}
