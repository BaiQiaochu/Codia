/** Governance uses the existing settings scopes. Evidence is an explicit user review,
 * never a model assertion or a retrieval counter. No authorization policy is learned here. */
import { type Context, type Hono } from 'hono';
import { FactStore } from '../../lib/memory/fact-store.ts';
import { ExperienceError, type ExperienceStore, openExperienceStore } from '../../lib/experience-store.ts';
import { denyWithoutScope, readAuthPrincipal } from '../http/capability-guard.ts';
import { resolveAgentStrict, AgentNotFoundError } from '../utils/resolve-agent.ts';
import { governanceQueryFromParams, projectOption, GovernanceQueryError } from '../../lib/memory/governance-query.ts';
import { listMemoryRunEvidence, findMemoryRunEvidence } from './memory-run-evidence.ts';
import { experienceApplicabilityDiagnostics } from '../../lib/memory/runtime-context.ts';
import { readMemorySourceEvidence } from './memory-source-evidence.ts';
import { safeJson } from '../hono-helpers.ts';

function errorResponse(c: Context, error: unknown, store?: ExperienceStore, id?: string) {
  const code = error instanceof ExperienceError ? error.code : error instanceof AgentNotFoundError ? 'not_found' : error instanceof GovernanceQueryError ? 'invalid_input' : 'internal_error';
  const status = ['revision_conflict', 'idempotency_conflict', 'duplicate_run'].includes(code) ? 409 : code === 'not_found' ? 404
    : ['evidence_required', 'invalid_transition', 'invalid_input', 'source_invalidated'].includes(code) ? 400 : 500;
  return c.json({ error: error instanceof Error ? error.message : String(error), code, ...(status === 409 && store && id ? { current: store.get(id) } : {}) }, status);
}

export function registerMemoryGovernanceRoutes(route: Hono, engine: unknown, getStoreForAgent: (agentId: string) => { store: FactStore; isTemp: boolean }) {
  route.post('/memories/batch', async c => {
    let tempStore: FactStore | undefined;
    try {
      const denied=denyWithoutScope(c,'settings.write');if(denied)return denied;
      const agent=resolveAgentStrict(engine,c),body=(await safeJson(c)) || {};
      if(body.confirmed!==true || !['confirm','forget'].includes(body.operation) || !Array.isArray(body.items) || !body.items.length || body.items.length>100
        || body.items.some(item=>!Number.isSafeInteger(item?.id) || item.id<1 || !(Number.isSafeInteger(item.expectedRevision) && item.expectedRevision>0 || typeof item.expectedUpdatedAt==='string'))
        || new Set(body.items.map(item=>item.id)).size!==body.items.length) return c.json({error:'Explicit confirmation and 1–100 distinct selected IDs with versions required'},400);
      const {store,isTemp}=getStoreForAgent(agent.id);if(isTemp)tempStore=store;
      const results=store.reviewSelected(body.items,body.operation);
      if(results.some(item=>item.ok)){agent.summaryManager?.clearCache?.();await (engine as any).updateConfig?.({}, {agentId:agent.id});}
      return c.json({results});
    }catch(error){return errorResponse(c,error);}finally{tempStore?.close();}
  });

  route.get('/memories/:id/evidence',async c=>{
    let tempStore:FactStore|undefined;
    try{
      const denied=denyWithoutScope(c,'settings.read');if(denied)return denied;
      const agent=resolveAgentStrict(engine,c),id=Number(c.req.param('id'));
      if(!Number.isSafeInteger(id) || id<1)return c.json({error:'Invalid memory ID'},400);
      const {store,isTemp}=getStoreForAgent(agent.id);if(isTemp)tempStore=store;
      const memory=store.getById(id);if(!memory)return c.json({error:'Memory not found'},404);
      return c.json(await readMemorySourceEvidence(engine,agent,memory));
    }catch(error){return errorResponse(c,error);}finally{tempStore?.close();}
  });

  route.get('/memories/projects',c=>{
    let tempStore:FactStore|undefined,experience:ExperienceStore|undefined;
    try{
      const denied=denyWithoutScope(c,'settings.read');if(denied)return denied;
      const agent=resolveAgentStrict(engine,c),query=governanceQueryFromParams(c.req.query());
      const {store,isTemp}=getStoreForAgent(agent.id);if(isTemp)tempStore=store;
      experience=openExperienceStore(agent.agentDir);
      const ids=[...new Set([...store.projectIds(query.q || ''),...experience.projectIds(query.q || '')])].sort();
      return c.json({projects:ids.slice(query.offset,query.offset+query.limit).map(projectOption),total:ids.length,limit:query.limit,offset:query.offset});
    }catch(error){return errorResponse(c,error);}finally{experience?.close();tempStore?.close();}
  });

  route.get('/memories/runs', async c=>{
    const denied=denyWithoutScope(c,'settings.read');if(denied)return denied;
    try{const agent=resolveAgentStrict(engine,c);return c.json(await listMemoryRunEvidence(engine,agent.id,governanceQueryFromParams(c.req.query())));}catch(error){return errorResponse(c,error);}
  });
  route.post('/memories/experiences/:entryId/attempt', async c=>{
    let store:ExperienceStore|undefined;const id=c.req.param('entryId');
    try{
      const denied=denyWithoutScope(c,'settings.write');if(denied)return denied;
      const principal=readAuthPrincipal(c);
      if(!['local_user','account_user','device'].includes(principal?.kind) || !(principal?.principalId || principal?.userId || principal?.deviceId))return c.json({error:'Explicit authenticated human adoption is required',code:'user_review_required'},403);
      const agent=resolveAgentStrict(engine,c),body=(await safeJson(c))||{};
      if(body.confirmed!==true || !Number.isSafeInteger(body.expectedRevision) || typeof body.runId!=='string')return c.json({error:'Confirm actual adoption and select a recorded run'},400);
      const run=await findMemoryRunEvidence(engine,agent.id,body.runId);
      if(!run)return c.json({error:'Recorded run was not found for this assistant',code:'run_not_found'},404);
      store=openExperienceStore(agent.agentDir);
      const entry=store.get(id);if(!entry)return c.json({error:'Experience not found',code:'not_found'},404);
      const diagnostics=experienceApplicabilityDiagnostics(entry.applicability,run.environment);
      if(diagnostics.length)return c.json({error:'Recorded run environment does not match this experience',code:'environment_mismatch',environmentDiagnostics:diagnostics},400);
      return c.json(store.recordAttempt(id,body.expectedRevision,run.runId));
    }catch(error){return errorResponse(c,error,store,id);}finally{store?.close();}
  });

  route.get('/memories/experiences', (c) => {
    let store: ExperienceStore | undefined;
    try {
      const denied = denyWithoutScope(c, 'settings.read');
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      store = openExperienceStore(agent.agentDir);
      return c.json({ ...store.queryPage(governanceQueryFromParams(c.req.query())), enabled: agent.experienceEnabled === true });
    } catch (error) { return errorResponse(c, error); }
    finally { store?.close(); }
  });

  route.patch('/memories/experiences/:entryId', async (c) => {
    let store: ExperienceStore | undefined;
    const id = c.req.param('entryId');
    try {
      const denied = denyWithoutScope(c, 'settings.write');
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const body = (await safeJson(c)) || {};
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
        || (body.patch === undefined && !['validated', 'enabled', 'withdrawn'].includes(body.state))) {
        return c.json({ error: 'Valid expectedRevision and target state are required' }, 400);
      }
      store = openExperienceStore(agent.agentDir);
      let entry;
      if (body.patch !== undefined) {
        const allowed = ['content', 'taskType', 'goal', 'preconditions', 'actions', 'verificationMethod', 'risks', 'rollback', 'applicability'];
        if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch) || Object.keys(body.patch).length === 0
          || Object.keys(body.patch).some(key => !allowed.includes(key)) || body.state !== undefined) {
          return c.json({ error: 'Invalid experience correction fields' }, 400);
        }
        entry = store.revise(id, body.expectedRevision, body.patch);
      } else entry = store.transition(id, body.expectedRevision, body.state);
      return c.json({ entry });
    } catch (error) { return errorResponse(c, error, store, id); }
    finally { store?.close(); }
  });

  route.post('/memories/experiences/:entryId/review', async (c) => {
    let store: ExperienceStore | undefined;
    const id = c.req.param('entryId');
    try {
      const denied = denyWithoutScope(c, 'settings.write');
      if (denied) return denied;
      const principal = readAuthPrincipal(c);
      // A scoped plugin/agent must not manufacture a human-reviewed verification.
      const reviewerId = principal?.principalId || principal?.userId || principal?.deviceId;
      if (!reviewerId || !['local_user', 'account_user', 'device'].includes(principal?.kind)) {
        return c.json({ error: 'Authenticated user review is required', code: 'user_review_required' }, 403);
      }
      const agent = resolveAgentStrict(engine, c);
      const body = (await safeJson(c)) || {};
      if (body.confirmed !== true || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
        || !['success', 'failure', 'unknown'].includes(body.outcome)
        || !['runId', 'eventId', 'summary'].every(key => typeof body[key] === 'string' && body[key].trim().length > 0 && body[key].length <= 4000)
        || body.evidenceOrigin!==undefined && !['recorded_run','external_manual'].includes(body.evidenceOrigin)) {
        return c.json({ error: 'Explicit review, revision, run, summary and outcome are required' }, 400);
      }
      let environment=body.environment,evidenceRef=body.evidenceRef,runSnapshot;
      const evidenceOrigin=body.evidenceOrigin || 'external_manual';
      if(evidenceOrigin==='recorded_run'){
        const run=await findMemoryRunEvidence(engine,agent.id,body.runId);
        if(!run)return c.json({error:'Recorded run was not found for this assistant',code:'run_not_found'},404);
        if(body.outcome==='success' && run.status!=='succeeded' || body.outcome==='failure' && !['failed','cancelled'].includes(run.status))return c.json({error:'Outcome does not match the recorded run status; pending/unknown runs cannot prove success',code:'run_outcome_mismatch'},400);
        environment=run.environment;evidenceRef=run.evidenceRef;
        runSnapshot={status:run.status,startedAt:run.startedAt,finishedAt:run.finishedAt,environmentProvenance:run.environmentProvenance};
      }else if(typeof evidenceRef!=='string' || !evidenceRef.trim() || !environment || typeof environment!=='object' || Array.isArray(environment))return c.json({error:'External manual evidence requires a reference and explicit environment; it is not automatically verified'},400);
      store = openExperienceStore(agent.agentDir);
      const entry = store.recordReview(id, body.expectedRevision, {
        runId: body.runId, eventId: body.eventId, reviewerId,
        outcome: body.outcome, evidenceRef, summary: body.summary,
        environment,evidenceOrigin,...(runSnapshot?{runSnapshot}:{}),
      });
      return c.json({ entry });
    } catch (error) { return errorResponse(c, error, store, id); }
    finally { store?.close(); }
  });

  route.get('/memories/extractions', (c) => {
    let tempStore: FactStore | undefined;
    try {
      const denied = denyWithoutScope(c, 'settings.read');
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const { store, isTemp } = getStoreForAgent(agent.id);
      if (isTemp) tempStore = store;
      return c.json(store.queryExtractionPage(governanceQueryFromParams(c.req.query())));
    } catch (error) { return errorResponse(c, error); }
    finally { tempStore?.close(); }
  });

  route.post('/memories/extractions/retry', async (c) => {
    let tempStore: FactStore | undefined;
    try {
      const denied = denyWithoutScope(c, 'settings.write');
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const body = (await safeJson(c)) || {};
      if (typeof body.key !== 'string' || !body.key || body.key.length > 1000) return c.json({ error: 'Extraction key is required' }, 400);
      const { store, isTemp } = getStoreForAgent(agent.id);
      if (isTemp) tempStore = store;
      const retried = store.retryExtraction(body.key);
      if (retried.error) return c.json({ error: retried.error }, retried.error === 'not_found' ? 404 : 409);
      return c.json({ ok: true, ...store.queryExtractionPage(governanceQueryFromParams(c.req.query())) });
    } catch (error) { return errorResponse(c, error); }
    finally { tempStore?.close(); }
  });
}
