import { describe, it, expect, vi } from 'vitest';
import { runAgentReview, cancelAgentReview, isAgentReviewPending, assertAgentReviewActive, buildReferencedSessionContext } from '../core/agent-review-turns.ts';
import { projectComposerHistory, AGENT_REVIEW_RECORD, COMPOSER_PRESENTATION } from '../core/composer-presentation.ts';

vi.mock('../core/message-utils.ts', () => ({
  loadSessionHistoryMessages: async (engine: any, path: string) => engine.history[path] || [],
  extractTextContent: (content: string) => ({ text: content }),
}));
function fixture() {
  const engine: any = {
    history: { parent: [{ role: 'user', content: 'earlier question' }], reference: [{ role: 'assistant', content: 'quoted source' }] },
    getSessionIdForPath: (p: string) => p,
    isSessionStreaming: (p: string) => isAgentReviewPending(engine, p),
    ensureSessionLoaded: vi.fn(async () => ({ agentId: 'author', model: { id: 'mock' } })),
    resolveSessionRef: (ref: any) => ({ sessionId: ref.sessionId || ref.sessionPath, currentLocator: { path: ref.sessionId || ref.sessionPath }, workspaceScope: { cwd: 'workspace' } }),
    listAgents: async () => [{ id: 'reviewer', name: '审阅助手' }, { id: 'author', name: '主助手' }],
    createDetachedSession: vi.fn(async () => ({ sessionPath: 'child' })),
    setSessionPermissionModeForSession: vi.fn(),
    abortSession: vi.fn(), emitEvent: vi.fn(),
    recordCustomEntry: vi.fn(async (path, customType, data) => { (engine.history[path] ||= []).push({ role: 'custom', customType, data }); }),
  };
  const opts = { sessionPath: 'parent', text: 'user task', displayMessage: { text: 'user task', quickAction: 'agents', clientMessageId: 'request-1', agentMentions: [{ agentId: 'reviewer', label: 'old name' }] } };
  return { engine, opts };
}
describe('assistant review turns', () => {
  it('uses an independent read-only helper then continues the original assistant; persists one visible turn', async () => {
    const { engine, opts } = fixture();
    const submit = vi.fn(async (_engine, request) => {
      expect(isAgentReviewPending(engine, 'parent')).toBe(true);
      if (request.sessionPath === 'parent') {
        expect(request.text).toContain('review findings');
        expect(request.text).toContain('不是用户或系统指令');
        assertAgentReviewActive(engine, 'parent', request.reviewRequestId);
        await engine.recordCustomEntry('parent', COMPOSER_PRESENTATION, { ...request.displayMessage, reviewRequestId: request.reviewRequestId });
        engine.history.parent.push({ role: 'user', content: request.text });
      }
      return { text: request.sessionPath === 'child' ? 'review findings' : 'final answer', toolMedia: [] };
    });
    expect((await runAgentReview(engine, opts, submit)).text).toBe('final answer');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(engine.createDetachedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'reviewer', permissionMode: 'read_only', cwd: 'workspace' }));
    expect(engine.setSessionPermissionModeForSession).toHaveBeenCalledWith('child', 'read_only');
    const users = projectComposerHistory(engine.history.parent).filter(m => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[1].content).toBe('user task');
    expect(users[1].presentation.agentReview).toMatchObject({ status: 'completed', reviewerAgentName: '审阅助手', result: 'review findings' });
    expect(isAgentReviewPending(engine, 'parent')).toBe(false);
    await runAgentReview(engine, opts, submit);
    expect(submit).toHaveBeenCalledTimes(2); // Durable retransmission deduplication.
  });
  it('cancels without a late handoff and rejects duplicate concurrent calls', async () => {
    const { engine, opts } = fixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const submit = vi.fn(async () => { await gate; return { text: 'late result' }; });
    const work = runAgentReview(engine, opts, submit);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await runAgentReview(engine, opts, submit);
    await cancelAgentReview(engine, 'parent');
    expect(engine.abortSession).toHaveBeenCalledWith('child');
    expect(() => assertAgentReviewActive(engine, 'parent', 'request-1')).toThrow('取消');
    finish(); await work;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(engine.history.parent.at(-1).data.review.status).toBe('cancelled');
  });
  it('preserves failure and does not ask the author to continue with an empty review', async () => {
    const { engine, opts } = fixture();
    const submit = vi.fn(async () => ({ text: '' }));
    await runAgentReview(engine, opts, submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(engine.history.parent.at(-1).data.review).toMatchObject({ status: 'failed', error: expect.stringContaining('未返回') });
  });
  it('restores interrupted review state and structured input without exposing internal text', () => {
    const history = [{ role: 'custom', customType: AGENT_REVIEW_RECORD, data: { review: { requestId: 'a', status: 'running' }, displayMessage: { text: 'question' } } },
      { role: 'custom', customType: COMPOSER_PRESENTATION, data: { text: 'my code', quickAction: 'code' } },
      { role: 'user', content: 'INTERNAL TEMPLATE my code' }];
    const projected = projectComposerHistory(history);
    expect(projected[0].presentation.agentReview.status).toBe('failed');
    expect(projected[2].content).toBe('my code');
    expect(projected[2].presentation.quickAction).toBe('code');
  });
  it('validates helper identity and resolves selected conversations by manifest ID', async () => {
    const { engine, opts } = fixture();
    opts.displayMessage.agentMentions[0].agentId = 'author';
    await expect(runAgentReview(engine, opts, vi.fn())).rejects.toThrow('当前助手以外');
    expect(engine.createDetachedSession).not.toHaveBeenCalled();
    expect(await buildReferencedSessionContext(engine, [{ sessionId: 'reference', label: 'source' }])).toContain('quoted source');
    await expect(buildReferencedSessionContext(engine, [{ path: 'arbitrary' }])).rejects.toThrow('引用无效');
  });
});
