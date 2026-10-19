import { Hono } from 'hono';
import { TemplateLaunchAdmissions } from './task-console-admissions.ts';
import { createHash } from 'node:crypto';
import { createRunBudget, inspectRunBudget, type RunBudgetLimits } from '../../lib/workflow/run-budget.ts';
import { getModelQualificationService } from '../../lib/model-qualification/index.ts';
import { diagnoseTemplateEnvironment } from './task-console-environment.ts';
import { diagnoseTemplateRuntime } from './task-console-diagnostics.ts';
import { safeJson } from '../hono-helpers.ts';
import { TASK_TEMPLATES, preflightTemplate, buildTemplateDraft, buildTemplatePlan, buildTemplateWorkflow } from '../../shared/task-console/templates.ts';
import { buildCompanyDelivery } from './task-console-delivery.ts';
import { createRequestContext } from '../http/boundary.ts';
import { collectConsoleRuns } from './task-console-records.ts';

/** Read-only projection plus explicitly requested launches through the existing workflow tool.
 * Kept studio-owner-only by the default HTTP route policy, like desk activities.
 */
export function createTaskConsoleRoute(engine: any, confirmStore: any, options: { qualificationService?: { inspect: (request: any) => any } } = {}) {
  if (options.qualificationService && process.env.NODE_ENV !== 'test') throw new Error('Test qualification injection is forbidden outside NODE_ENV=test');
  const durableAdmissions = new TemplateLaunchAdmissions(engine.codiaHome || engine.agent?.agentDir);
  const admissions = new Map<string, { fingerprint: string; result: Promise<any> }>();
  const route = new Hono();
  route.get('/task-console', async (c) => {
    const { runs, limitations } = await collectConsoleRuns(engine);
    return c.json({ runs, approvals: confirmStore.listPending(), interruptedApprovals: confirmStore.listInterrupted?.().map((a: any) => ({ id: a.id, kind: a.kind, sessionPath: a.sessionPath })) || [], generatedAt: Date.now(),
      limitations });
  });
  const companyTask = async (taskId: string) => {
    const service = engine.pluginManager?.getPlugin?.('company')?.ctx?._company?.service;
    if (!service) throw Object.assign(new Error('company_service_unavailable'), { status: 503 });
    const task = (await service.store.listTasks()).find((entry: any) => entry.id === taskId);
    if (!task) throw Object.assign(new Error('company_task_not_found'), { status: 404 });
    return { service, task };
  };
  route.get('/task-console/company/:taskId/delivery', async c => {
    try {
      const { task } = await companyTask(c.req.param('taskId'));
      return c.json(buildCompanyDelivery(engine, task, createRequestContext(c, engine)));
    } catch (error: any) { return c.json({ error: error.message || 'company_delivery_unavailable' }, error.status || 500); }
  });
  route.post('/task-console/company/:taskId/review', async c => {
    try {
      const { task, service } = await companyTask(c.req.param('taskId'));
      const context = createRequestContext(c, engine);
      const delivery = buildCompanyDelivery(engine, task, context);
      const body = await safeJson(c) || {};
      if (typeof body.version !== 'string' || body.version !== delivery.version) return c.json({ error: 'delivery_changed', message: '报告或产物版本已变化，请刷新后重新核对。' }, 409);
      if (!Array.isArray(body.items) || body.items.length > 100) return c.json({ error: 'review_items_required' }, 400);
      if (body.items.some((item: any) => item?.verdict === 'pass') && delivery.artifacts.some(a => a.state !== 'available')) return c.json({ error: 'delivery_artifacts_unavailable', message: '部分产物不可读取或版本无法核对，不能记录通过。' }, 409);
      const updated = await service.reviewTask(task.id, { expectedRevision: delivery.revision, version: delivery.version, items: body.items,
        reviewedBy: context.principalId || context.userId || 'studio_owner' });
      return c.json(buildCompanyDelivery(engine, updated, context));
    } catch (error: any) { return c.json({ error: error.message || 'company_review_failed' }, error.status || 500); }
  });
  const prepare = async (body: any) => {
    const selectedModel = structuredClone(engine.currentModel || null);
    const selectedAgent = engine.agent;
    const selectedSessionPath = engine.currentSessionPath;
    const template = TASK_TEMPLATES.find(t => t.id === body.templateId && t.version === body.version);
    if (!template) return null;
    const inputs: Record<string, string> = {};
    for (const key of template.inputs) inputs[key] = typeof body.inputs?.[key] === 'string' ? body.inputs[key].slice(0, 10000) : '';
    const diagnostics = diagnoseTemplateRuntime(engine, body.budget);
    const environment = diagnoseTemplateEnvironment(engine, template, inputs, body);
    let qualification: any = { state: engine.currentModel ? 'unknown' : 'fail', reason: '模型能力尚未验证。' };
    if (engine.currentModel) {
      try { qualification = await (options.qualificationService || getModelQualificationService(engine)).inspect({ requiredCapabilities: ['text', 'tool'] }); }
      catch { qualification = { state: 'unknown', reason: '模型资格记录暂不可读取。' }; }
    }
    const limits: RunBudgetLimits = {
      maxTokens: body.budget?.maxTokens, maxUsd: body.budget?.maxUsd,
      maxSteps: body.budget?.maxSteps, maxDurationMs: body.budget?.maxDurationMs,
      maxOutputTokensPerCall: body.budget?.maxOutputTokensPerCall,
      maxModelCalls: body.budget?.maxModelCalls ?? 32,
    };
    const budgetContract = inspectRunBudget(limits, engine.currentModel);
    if (body.connectorTools !== undefined && !Array.isArray(body.connectorTools)) environment.tools.state = 'fail';
    const result = preflightTemplate(template, inputs, { connectors: environment.tools.state, directory: environment.directory.state,
      model: qualification.state, budget: budgetContract.state });
    if (template.id === 'weekly-draft' && inputs['IANA 时区']) {
      let valid = true;
      try { new Intl.DateTimeFormat('en', { timeZone: inputs['IANA 时区'] }); } catch { valid = false; }
      result.checks.push({ id: 'timezone', label: 'IANA 时区', state: valid ? 'pass' : 'fail' });
    }
    if (JSON.stringify(engine.currentModel || null) !== JSON.stringify(selectedModel) || engine.agent !== selectedAgent || engine.currentSessionPath !== selectedSessionPath) result.checks.push({ id: 'runtime', label: '运行配置稳定性', state: 'fail' });
    result.checks.push({ id: 'workflow', label: '已有工作流与会话', state: typeof engine.agent?.workflowTool?.execute === 'function' && engine.currentSessionPath && durableAdmissions.directory ? 'pass' : 'fail' });
    const ready = result.checks.every(check => check.state === 'pass');
    return { template, limits, selectedModel, selectedAgent, selectedSessionPath, response: { ...result, ready, executionAllowed: ready,
      modelId: engine.currentModel?.id || null, qualificationEvidence: qualification, budgetContract,
      reason: ready ? '预检通过，可显式启动实验运行。模板尚无真实端到端验收，能力探测不代表模板交付质量已获验证。' : '预检尚未通过，未派发任务。请解决以下失败或未知项。',
      environment, plan: buildTemplatePlan(template, inputs), diagnostics,
      draft: buildTemplateDraft(template, inputs) + `\n预算目标：${diagnostics.budget.maxTokens ?? '未设置'} tokens；${diagnostics.budget.maxUsd ?? '未设置'} USD。草稿本身不执行预算；使用模板执行按钮才启用本地预留契约。${budgetContract.note}` } };
  };
  route.post('/task-console/preflight', async c => {
    const prepared = await prepare(await safeJson(c) || {});
    return prepared ? c.json(prepared.response) : c.json({ error: 'unknown_template_version' }, 400);
  });
  // Recompute trusted state at launch. Caller pass flags and qualification claims are ignored.
  route.post('/task-console/execute', async c => {
    const body = await safeJson(c) || {};
    if (body.confirmExperimental !== true) return c.json({ error: 'explicit_experimental_launch_required' }, 400);
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) return c.json({ error: 'valid_request_id_required' }, 400);
    const fingerprint = createHash('sha256').update(JSON.stringify([body.templateId, body.version, body.inputs, body.workspace, body.connectorTools, body.budget, engine.currentSessionPath, engine.agent?.id])).digest('hex');
    const prior = admissions.get(body.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return c.json({ error: 'request_id_payload_mismatch' }, 409);
      const result = await prior.result;
      return c.json(result.body, result.status);
    }
    if (admissions.size >= 1000) return c.json({ error: 'launch_deduplication_capacity_reached' }, 503);
    let claim: ReturnType<TemplateLaunchAdmissions['claim']>;
    try { claim = durableAdmissions.claim(body.requestId, fingerprint); }
    catch { return c.json({ error: 'template_launch_checkpoint_unavailable' }, 503); }
    if (claim.owned === false) return c.json(claim.result.body as any, claim.result.status as any);
    const claimToken = claim.token;
    // Reserve this request key before awaiting preflight or dispatch; duplicates
    // share one in-flight result. Restart recovery remains owned by workflow journals.
    const pending = (async () => {
      const prepared = await prepare(body);
      if (!prepared) return { status: 400, body: { error: 'unknown_template_version' } };
      if (!prepared.response.executionAllowed) return { status: 409, body: { ...prepared.response, error: 'template_preflight_blocked' } };
      const { template, limits, response } = prepared;
      if (JSON.stringify(engine.currentModel || null) !== JSON.stringify(prepared.selectedModel) || engine.agent !== prepared.selectedAgent || engine.currentSessionPath !== prepared.selectedSessionPath) return { status: 409, body: { error: 'runtime_changed_retry_preflight' } };
      const model = prepared.selectedModel;
      const parentSessionPath = prepared.selectedSessionPath;
      const workflowTool = prepared.selectedAgent?.workflowTool;
      const runBudget = createRunBudget(limits, model);
      const allowed = [...new Set([...template.requiredTools, ...(body.connectorTools || [])])];
      const builtins = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
      const workspace = response.environment.directory.path!;
      const result = await workflowTool.execute(`template-${body.requestId}`, {
        script: buildTemplateWorkflow(template),
        args: { plan: response.plan, budgetTokens: limits.maxTokens, maxSteps: limits.maxSteps, maxDurationMs: limits.maxDurationMs },
      }, undefined, undefined, {
        sessionManager: { getSessionFile: () => parentSessionPath, getCwd: () => workspace },
        runBudget, executionModel: model, workspaceFolders: [workspace], authorizedFolders: [],
        toolFilter: allowed.filter(name => !builtins.has(name)), builtinFilter: allowed.filter(name => builtins.has(name)),
      });
      if (result?.details?.error) return { status: 409, body: { error: result.details.error, budget: runBudget.snapshot() } };
      const runId = result?.details?.runId || result?.details?.taskId;
      if (!runId) return { status: 500, body: { error: 'workflow_did_not_return_persisted_run', budget: runBudget.snapshot() } };
      return { status: 202, body: { runId, status: 'running', templateId: template.id, version: template.version, qualification: template.qualification,
        sessionPath: parentSessionPath, budget: runBudget.snapshot(), note: '已派发到现有工作流。派发成功不代表完成；请查看运行状态与产物。' } };
    })().then(result => { durableAdmissions.complete(body.requestId, claimToken, result); return result; }).catch((error: any) => ({ status: 500, body: { error: error?.message || 'template_execution_failed' } }));
    admissions.set(body.requestId, { fingerprint, result: pending });
    const result = await pending;
    return c.json(result.body as any, result.status as any);
  });
  return route;
}
