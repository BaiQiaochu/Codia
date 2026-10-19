import path from 'node:path';
import fs from 'node:fs';
import { Hono } from 'hono';
import { denyWithoutScope } from '../http/capability-guard.ts';
import { resolveAgentStrict } from '../utils/resolve-agent.ts';
import { safeJson } from '../hono-helpers.ts';
import { FactStore } from '../../lib/memory/fact-store.ts';
import { openExperienceStore } from '../../lib/experience-store.ts';
import { applyMemoryRetention, readRetentionPolicy, retentionReport, writeRetentionPolicy, retentionPolicyRevision, withCurrentRetentionPolicy } from '../../lib/memory/retention-policy.ts';
export function createUsageMaintenanceRoute(engine: any) {
  const route = new Hono();
  route.get('/usage/budget', c => {
    const denied = denyWithoutScope(c, 'settings.read'); if (denied) return denied;
    return c.json(engine.usageLedger.getBudgetReport(c.req.query('agentId')));
  });
  route.patch('/usage/budget', async c => {
    const denied = denyWithoutScope(c, 'settings.write'); if (denied) return denied;
    try { const body = await safeJson(c); if (!Number.isSafeInteger(body?.expectedRevision)) return c.json({ error: 'Current budget revision is required' }, 400); engine.usageLedger.setBudgetConfig(body.config, body.expectedRevision); return c.json(engine.usageLedger.getBudgetReport()); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Invalid budget configuration' }, 400); }
  });
  const maintenance = async c => {
    const denied = denyWithoutScope(c, c.req.method === 'GET' ? 'settings.read' : 'settings.write'); if (denied) return denied;
    let fact: any, experience: any, ownFact = false;
    try {
      const body = c.req.method === 'GET' ? null : await safeJson(c);
      const agent = resolveAgentStrict(engine, c);
      const memoryDir = path.join(agent.agentDir, 'memory');
      fact = agent.factStore;
      if (!fact) { fs.mkdirSync(memoryDir, { recursive: true }); fact = new FactStore(agent.factsDbPath || path.join(memoryDir, 'facts.db')); ownFact = true; }
      experience = openExperienceStore(agent.agentDir);
      let policy = readRetentionPolicy(memoryDir);
      if (body && typeof body.expectedRevision !== 'string') return c.json({ error: 'Current retention policy revision is required' }, 400);
      if (c.req.method === 'PATCH') policy = writeRetentionPolicy(memoryDir, body.policy, body.expectedRevision);
      let report = retentionReport(fact, experience);
      if (c.req.method === 'POST') {
        if (body?.confirmed !== true) return c.json({ error: 'Explicit confirmation is required to compact completed history' }, 400);
        report = withCurrentRetentionPolicy(memoryDir, body.expectedRevision, current => {
          policy = current; return applyMemoryRetention(fact, experience, current);
        });
      }
      return c.json({ policy, revision: retentionPolicyRevision(policy), report, budget: engine.usageLedger.getBudgetReport(agent.id), memoryEnabled: agent.memoryMasterEnabled, experienceEnabled: agent.experienceEnabled });
    } catch (error: any) { return c.json({ error: error.message }, error.status === 404 ? 404 : error.status === 409 ? 409 : 400); }
    finally { if (ownFact) fact?.close(); experience?.close(); }
  };
  route.get('/memories/maintenance', maintenance); route.patch('/memories/maintenance', maintenance); route.post('/memories/maintenance', maintenance);
  return route;
}
