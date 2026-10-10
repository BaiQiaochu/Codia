import { codiaFetch } from '../hooks/use-codia-fetch';

export interface PromptOptimizationRequest {
  prompt: string;
  sessionPath?: string | null;
  agentId?: string | null;
  locale?: string | null;
}

export async function requestPromptOptimization(request: PromptOptimizationRequest): Promise<string> {
  const prompt = String(request.prompt || '').trim();
  if (!prompt) throw new Error('empty_prompt');

  const res = await codiaFetch('/api/prompts/optimize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeout: 90_000,
    body: JSON.stringify({
      prompt,
      ...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.locale ? { locale: request.locale } : {}),
    }),
  });
  const data = await res.json();
  const optimizedPrompt = typeof data?.optimizedPrompt === 'string'
    ? data.optimizedPrompt.trim()
    : '';
  if (!optimizedPrompt) throw new Error(data?.error || 'empty_optimized_prompt');
  return optimizedPrompt;
}
