import { normalizeConsoleRun, type ConsoleRun } from '../../shared/task-console/records.ts';

/** Server-owned, read-only records. Never activates plugins, loads sessions, or dispatches work.
 * Missing times/environment remain unknown. Session cwd is labelled current, not historical. */
export async function collectConsoleRuns(engine: any): Promise<{ runs: ConsoleRun[]; limitations: string[] }> {
  const limitations = ['仅汇总已有活动记录；空列表不代表所有外部任务均已完成。'];
  const runs: ConsoleRun[] = [];
  try { runs.push(...(engine.activityHub?.list?.() || []).map((entry: any) => normalizeConsoleRun(entry, 'workflow'))); }
  catch { limitations.push('工作流记录读取失败。'); }
  for (const agent of engine.listAgents?.() || []) {
    try { runs.push(...(engine.getActivityStore?.(agent.id)?.list() || []).map((entry: any) => normalizeConsoleRun({ ...entry, agentId: entry.agentId || agent.id }, 'activity', agent.name))); }
    catch { limitations.push(`后台活动记录读取失败：${agent.id}`); }
  }
  const service = engine.pluginManager?.getPlugin?.('company')?.ctx?._company?.service;
  if (service) {
    try {
      for (const company of await service.listCompanies()) {
        for (const task of await service.store.listTasks(company.id)) {
          runs.push(normalizeConsoleRun({ ...task, companyId: task.companyId || company.id,
            label: task.title, summary: task.acceptanceFailure || task.report || task.description,
            agentName: task.assigneeAgentName || task.assigneeTitle, agentId: task.assigneeAgentId,
            parentTaskId: task.parentTaskId || task.source?.runId,
          }, 'company'));
        }
      }
    } catch { limitations.push('团队任务读取失败；其他记录仍可查看。'); }
  } else { limitations.push('团队插件尚未加载；未主动启用插件或创建公司记录。'); }
  for (const run of runs) {
    if (!run.environment.cwd && run.sessionPath) {
      try { const cwd = engine.getSessionCwd?.(run.sessionPath); if (typeof cwd === 'string' && cwd) run.environment = { cwd, provenance: 'session_current' }; } catch { /* Missing runtime session is not evidence of a historic cwd. */ }
    }
  }
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { runs, limitations };
}
