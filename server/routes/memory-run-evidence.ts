import { collectActivityRuns } from './activity-run-records.ts';
import type { ExperienceEnvironment } from '../../lib/experience-store.ts';
import type { GovernanceQuery } from '../../lib/memory/governance-query.ts';
export interface MemoryRunEvidence {
  runId:string;title:string;status:string;startedAt:string|null;finishedAt:string|null;projectId:string|null;
  environment:ExperienceEnvironment;evidenceRef:string;sessionId:string|null;environmentProvenance:'recorded'|'session_current'|'unknown';
  environmentDiagnostics:string[];evidenceOrigin:'recorded_run';summary:string;artifacts:unknown[];timeProvenance:unknown;
}
/** Projects and versions are historical evidence only when recorded by the executor.
 * A current session cwd may help locate a source, but cannot verify an old run. */
export async function listMemoryRunEvidence(engine:unknown, agentId:string, query:GovernanceQuery={}) {
  const {runs,limitations}=await collectActivityRuns(engine);
  const all:MemoryRunEvidence[]=runs.filter(run=>run.agentId===agentId).map(run=>{
    const snapshot=run.environment as typeof run.environment & ExperienceEnvironment;
    const recorded=snapshot.provenance==='recorded';
    const projectId=recorded ? snapshot.projectId || null : null;
    const environment:ExperienceEnvironment=recorded?{projectId,
      ...(snapshot.channel?{channel:snapshot.channel}:{}),...(snapshot.platform?{platform:snapshot.platform}:{}),
      ...(snapshot.appVersion?{appVersion:snapshot.appVersion}:{}),...(snapshot.dependencyVersions?{dependencyVersions:snapshot.dependencyVersions}:{})}:{};
    return {runId:run.id,title:run.title,status:run.status,startedAt:run.startedAt===null?null:new Date(run.startedAt).toISOString(),finishedAt:run.finishedAt===null?null:new Date(run.finishedAt).toISOString(),projectId,environment,
      evidenceRef:`recorded-run:${run.id}`,sessionId:run.sessionPath,environmentProvenance:snapshot.provenance,
      summary:run.summary.slice(0,8000),artifacts:run.artifactDetails.slice(0,20),timeProvenance:run.timeProvenance,
      environmentDiagnostics:[...(!recorded?['missing_recorded_environment']:[]),...(!projectId?['missing_project']:[]),...(!environment.channel?['missing_channel']:[]),...(!environment.dependencyVersions?['missing_dependency_snapshot']:[])],evidenceOrigin:'recorded_run' as const};
  });
  const matching=all.filter(run=>(!query.q || `${run.title} ${run.runId}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) && (!query.projectId || run.projectId===query.projectId)
    && (!query.status || run.status===query.status) && (!query.from || !!run.startedAt && run.startedAt>=query.from) && (!query.to || !!run.startedAt && run.startedAt<=query.to));
  const limit=query.limit??25,offset=query.offset??0;
  return {runs:matching.slice(offset,offset+limit),total:matching.length,limit,offset,limitations};
}
export async function findMemoryRunEvidence(engine:unknown,agentId:string,runId:string) {
  // Recorded activity is authoritative. Never accept a run ID as proof of existence by itself.
  const {runs}=await listMemoryRunEvidence(engine,agentId,{limit:Number.MAX_SAFE_INTEGER});
  return runs.find(run=>run.runId===runId) || null;
}
