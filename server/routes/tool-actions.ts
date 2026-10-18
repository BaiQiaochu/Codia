import { Hono } from 'hono';
import { toolActionSessionRef } from '../../lib/tools/tool-action-ledger.ts';
import type { ToolActionMetadata } from '../../shared/task-console/tool-actions.ts';

/** Read-only owner inspection; default HTTP policy restricts these routes to studio_owner. */
export function createToolActionsRoute(engine: any) {
  const route = new Hono();
  const sessions = async () => {
    const known = new Map<string, string>();
    for (const session of await engine.listSessions()) {
      if (typeof session.path === 'string') known.set(toolActionSessionRef(session.path), session.path);
    }
    return known;
  };
  const project = (record: ToolActionMetadata, known: Map<string, string>) => ({
    ...record, sessionPath: record.sessionRef ? known.get(record.sessionRef) || null : null,
  });
  route.get('/tool-actions', async c => {
    try {
      if (!engine.toolActionLedger) return c.json({ error: 'action_ledger_unavailable' }, 503);
      const result = engine.toolActionLedger.list();
      const known = await sessions();
      return c.json({ ...result, actions: result.actions.map((record: ToolActionMetadata) => project(record, known)),
        note: '只读检查。结果未知的写操作不会自动重新提交；打开原会话也不会重试。外部结果需要另行核实。' });
    } catch { return c.json({ error: 'action_inspection_unavailable' }, 503); }
  });
  route.get('/tool-actions/:actionId', async c => {
    const id = c.req.param('actionId');
    if (!/^action_[a-f0-9]{64}$/.test(id)) return c.json({ error: 'invalid_action_id' }, 400);
    try {
      if (!engine.toolActionLedger) return c.json({ error: 'action_ledger_unavailable' }, 503);
      const record = engine.toolActionLedger.inspect(id);
      if (!record) return c.json({ error: 'action_not_found' }, 404);
      return c.json({ action: project(record, await sessions()) });
    } catch { return c.json({ error: 'action_inspection_unavailable' }, 503); }
  });
  return route;
}
