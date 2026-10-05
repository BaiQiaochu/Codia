import { gsapFetch } from '../hooks/use-gsap-fetch';

export type ResearchMode = 'quick' | 'deep' | 'academic' | 'library';

export interface ResearchReportRequest {
  topic: string;
  mode?: ResearchMode | null;
  sessionPath?: string | null;
  agentId?: string | null;
  locale?: string | null;
  exportFormats?: readonly string[] | null;
}

export interface ResearchReportResponse {
  report: string;
  mode: string;
  generatedAt: string | null;
}

export async function requestResearchReport(request: ResearchReportRequest): Promise<ResearchReportResponse> {
  const topic = String(request.topic || '').trim();
  if (!topic) throw new Error('empty_research_topic');

  const res = await gsapFetch('/api/prompts/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeout: 180_000,
    body: JSON.stringify({
      topic,
      mode: request.mode || 'deep',
      exportFormats: request.exportFormats?.length ? [...request.exportFormats] : ['word', 'pdf'],
      ...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.locale ? { locale: request.locale } : {}),
    }),
  });
  const data = await res.json();
  const report = typeof data?.report === 'string' ? data.report.trim() : '';
  if (!report) throw new Error(data?.error || 'empty_research_report');
  return {
    report,
    mode: typeof data?.mode === 'string' ? data.mode : 'deep',
    generatedAt: typeof data?.generatedAt === 'string' ? data.generatedAt : null,
  };
}
