import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '../lib/pi-sdk/index.ts';
import { createRunBudget, inspectRunBudget, RunBudget } from '../lib/workflow/run-budget.ts';
import { installRunBudgetStreamGuard } from '../lib/workflow/run-budget-stream.ts';
const model = { id: 'mock-model', provider: 'mock-provider', api: 'openai-completions', contextWindow: 1000, maxTokens: 500, cost: { input: 1, output: 2, cacheRead: .5, cacheWrite: 2 } };
const limits = { maxTokens: 2000, maxUsd: 1, maxSteps: 4, maxDurationMs: 10000, maxOutputTokensPerCall: 100, maxModelCalls: 4 };
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 };
const message = (u: any = usage) => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: u });
const drain = async (stream: AsyncIterable<any>) => { const out = []; for await (const event of stream) out.push(event); return out; };

describe('local run budget reservations', () => {
  it('restores verified cumulative usage and blocks uncertain reservations', () => {
    let now = 1000;
    const original = new RunBudget(limits, model, () => now);
    original.settle(original.reserve(model).id, usage);
    now += 100;
    const saved = original.exportState();
    const restored = new RunBudget(limits, model, () => now + 5000, saved);
    expect(restored.snapshot()).toMatchObject({ calls: 1, committedTokens: 110, committedUsd: 0.00012 });
    expect(restored.exportState().elapsedMs).toBe(100);
    restored.reserve(model);
    expect(() => new RunBudget(limits, model, () => now, restored.exportState())).toThrow(/Unsettled/);
  });
  it('atomically reserves concurrent calls before any dispatch and frees only verified unused allowance', async () => {
    const budget = createRunBudget(limits, model);
    const results = await Promise.allSettled([Promise.resolve().then(() => budget.reserve(model)), Promise.resolve().then(() => budget.reserve(model))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(budget.snapshot()).toMatchObject({ calls: 1, reservedTokens: 1100, committedTokens: 0 });
    budget.settle((results[0] as PromiseFulfilledResult<any>).value.id, usage);
    expect(budget.snapshot()).toMatchObject({ committedTokens: 110, committedUsd: .00012, reservedTokens: 0 });
    expect(() => budget.reserve(model)).toThrow(/reservation budget/);
    const verified = createRunBudget(limits, model);
    verified.settle(verified.reserve(model).id, usage);
    expect(verified.reserve(model).reservedTokens).toBe(1100);
  });
  it('fails unknown/placeholder prices, unbounded APIs and insufficient full-window allowance closed', () => {
    for (const current of [{ ...model, cost: { input: 0, output: 0 } }, { ...model, cost: undefined }, { ...model, api: 'openai-codex-responses' }, { ...model, contextWindow: undefined }]) {
      expect(inspectRunBudget(limits, current as any).state).toBe('fail');
    }
    expect(inspectRunBudget({ ...limits, maxTokens: 100 }, model)).toMatchObject({ state: 'fail', reservationTokens: 1100 });
    expect(inspectRunBudget({ ...limits, maxUsd: .00001 }, model).state).toBe('fail');
  });
  it('keeps reservations and blocks new calls for missing or invalid usage instead of assuming zero', () => {
    const budget = createRunBudget(limits, model);
    const reservation = budget.reserve(model);
    expect(() => budget.settle(reservation.id, undefined)).toThrow(/usage/);
    expect(budget.snapshot()).toMatchObject({ state: 'blocked', reservedTokens: 1100, committedTokens: 0 });
    expect(() => budget.reserve(model)).toThrow(/blocked/);
  });
  it('blocks before dispatch if reservation checkpoint persistence fails', () => {
    const budget = createRunBudget(limits, model);
    const unsubscribe = budget.subscribe(() => { throw new Error('disk failure'); });
    expect(() => budget.reserve(model)).toThrow('disk failure');
    expect(budget.snapshot()).toMatchObject({ state: 'blocked', reservedTokens: 1100 });
    unsubscribe();
    expect(() => budget.reserve(model)).toThrow(/checkpoint/);
  });
  it('detects actual output exceeding the reserved maximum and config changes', () => {
    const budget = createRunBudget(limits, model);
    expect(() => budget.reserve({ ...model, cost: { ...model.cost, input: 100 } })).toThrow(/changed/);
    const reservation = budget.reserve(model);
    expect(() => budget.settle(reservation.id, { ...usage, output: 101, totalTokens: 201 })).toThrow(/exceeds/);
    expect(budget.snapshot().providerInvoiceHardCap).toBe(false);
  });
  it('enforces model-call and elapsed-time bounds independently', () => {
    let now = 100;
    const budget = new RunBudget({ ...limits, maxModelCalls: 1 }, model, () => now);
    budget.settle(budget.reserve(model).id, usage);
    expect(() => budget.reserve(model)).toThrow(/model-call/);
    const timed = new RunBudget(limits, model, () => now);
    now = 10200;
    expect(() => timed.assertActive()).toThrow(/duration/);
  });
});

describe('bounded SDK stream wrapper', () => {
  it.each(['unresolved stream promise', 'never-yielding stream'])('unblocks the real SDK prompt on cancellation with a %s', async mode => {
    const budget = createRunBudget(limits, model);
    const agent = new Agent({ initialState: { model: model as any, systemPrompt: 'Abort fixture.', tools: [] }, streamFn: async () => {
      if (mode === 'unresolved stream promise') return await new Promise<any>(() => {});
      return (async function* () { await new Promise(() => {}); yield {} as any; })() as any;
    } });
    installRunBudgetStreamGuard({ agent }, budget);
    const completion = agent.prompt('Test cancellation.');
    await vi.waitFor(() => expect(budget.snapshot().calls).toBe(1));
    agent.abort();
    await Promise.race([completion, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('SDK consumer remained stuck after abort')), 500))]);
    expect(budget.snapshot()).toMatchObject({ state: 'blocked', reservedTokens: 1100, committedTokens: 0 });
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'aborted' });
  });
  it.each(['abort', 'provider error'])('ends the real SDK prompt despite checkpoint observer failure during %s', async mode => {
    const budget = createRunBudget(limits, model);
    let rejectProvider!: (error: Error) => void;
    const agent = new Agent({ initialState: { model: model as any, systemPrompt: 'Checkpoint failure fixture.', tools: [] }, streamFn: async () => await new Promise<any>((_resolve, reject) => { rejectProvider = reject; }) });
    installRunBudgetStreamGuard({ agent }, budget);
    const completion = agent.prompt('Test failed checkpoint.');
    await vi.waitFor(() => expect(rejectProvider).toBeTypeOf('function'));
    const observer = vi.fn(() => { throw new Error('checkpoint error SECRET_FIXTURE_TOKEN'); });
    budget.subscribe(observer);
    if (mode === 'abort') agent.abort();
    else rejectProvider(new Error('provider error SECRET_FIXTURE_TOKEN'));
    await Promise.race([completion, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('SDK consumer remained stuck after checkpoint failure')), 500))]);
    expect(observer).toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({ state: 'blocked', reservedTokens: 1100, committedTokens: 0 });
    expect(() => budget.reserve(model)).toThrow(/checkpoint/);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: mode === 'abort' ? 'aborted' : 'error' });
    expect(JSON.stringify({ budget: budget.snapshot(), messages: agent.state.messages })).not.toContain('SECRET_FIXTURE_TOKEN');
  });
  it('guards the installed SDK Agent.streamFunction during a real prompt loop', async () => {
    const budget = createRunBudget(limits, model);
    const transport = vi.fn(async (_model: any, _context: any, options: any) => {
      const payload = await options.onPayload({ model: model.id, max_completion_tokens: 9999 }, model);
      expect(payload.max_completion_tokens).toBe(100);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: { ...message(), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() } } as any);
      stream.end(); return stream;
    });
    const agent = new Agent({ initialState: { model: model as any, systemPrompt: 'Deterministic bounded fixture.', tools: [] }, streamFn: transport });
    expect((agent as any).streamFn).toBeUndefined();
    installRunBudgetStreamGuard({ agent }, budget);
    await agent.prompt('Reply briefly.');
    expect(transport).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toMatchObject({ calls: 1, committedTokens: 110, reservedTokens: 0 });
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  });
  it('prevents the real SDK loop from executing tool calls with unknown usage', async () => {
    const budget = createRunBudget(limits, model); const execute = vi.fn();
    const agent = new Agent({ initialState: { model: model as any, systemPrompt: 'Fixture.', tools: [{ name: 'side_effect', label: 'Fixture', description: 'Never execute', parameters: { type: 'object', properties: {} }, execute } as any] }, streamFn: async (_model: any, _context: any, options: any) => {
      await options.onPayload({ model: model.id, max_completion_tokens: 100 }, model);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'toolUse', message: { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'must-not-run', name: 'side_effect', arguments: {} }], usage: undefined } } as any);
      stream.end(); return stream;
    } });
    installRunBudgetStreamGuard({ agent }, budget);
    await agent.prompt('Test rejection.');
    expect(execute).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({ state: 'blocked', reservedTokens: 1100 });
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'error' });
  });

  it('forces output cap after payload overrides, disables retry/cache, and settles before terminal success', async () => {
    const budget = createRunBudget(limits, model);
    const original = vi.fn(async (_model, _context, options) => {
      expect(options).toMatchObject({ maxTokens: 100, maxRetries: 0, cacheRetention: 'none', transport: 'sse' });
      const payload = await options.onPayload({ model: 'expensive-override', max_completion_tokens: 9999, n: 4 }, model);
      expect(payload).toMatchObject({ model: model.id, max_completion_tokens: 100, n: 1 });
      return (async function* () { yield { type: 'done', reason: 'stop', message: message() }; })();
    });
    const session = { agent: { streamFn: original } };
    installRunBudgetStreamGuard(session, budget);
    const events = await drain(await session.agent.streamFn(model, { messages: [] }, { maxTokens: 9999, onPayload: () => ({ max_completion_tokens: 8888, n: 9 }) }));
    expect(events.at(-1).type).toBe('done');
    expect(budget.snapshot()).toMatchObject({ committedTokens: 110, reservedTokens: 0 });
  });
  it('replaces done with error on unreliable usage so tool calls are never dispatched from that response', async () => {
    const budget = createRunBudget(limits, model);
    const session: any = { agent: { streamFn: async (_m: any, _c: any, options: any) => {
      await options.onPayload({ max_completion_tokens: 100 }, model);
      return (async function* () { yield { type: 'done', reason: 'toolUse', message: message({}) }; })();
    } } };
    installRunBudgetStreamGuard(session, budget);
    const events = await drain(await session.agent.streamFn(model, {}));
    expect(events.map(event => event.type)).toEqual(['error']);
    expect(budget.snapshot()).toMatchObject({ state: 'blocked', reservedTokens: 1100 });
    await expect(session.agent.streamFn(model, {})).rejects.toThrow(/blocked/);
  });
  it('fails closed if an adapter bypasses the payload cap hook', async () => {
    const budget = createRunBudget(limits, model);
    const session: any = { agent: { streamFn: async () => (async function* () { yield { type: 'done', message: message() }; })() } };
    installRunBudgetStreamGuard(session, budget);
    const events = await drain(await session.agent.streamFn(model, {}));
    expect(events.at(-1).error.errorMessage).toMatch(/bypassed/);
    expect(budget.snapshot().state).toBe('blocked');
  });
  it('never persists or forwards provider error credentials', async () => {
    const budget = createRunBudget(limits, model);
    const session: any = { agent: { streamFn: async () => { throw new Error('https://provider.invalid?api_key=SECRET_FIXTURE_TOKEN'); } } };
    installRunBudgetStreamGuard(session, budget);
    const events = await drain(await session.agent.streamFn(model, {}));
    expect(JSON.stringify({ events, budget: budget.snapshot() })).not.toMatch(/SECRET_FIXTURE|provider.invalid/);
    expect(events.at(-1).type).toBe('error');
    const eventBudget = createRunBudget(limits, model);
    const eventSession: any = { agent: { streamFn: async () => (async function* () { yield { type: 'error', error: { errorMessage: 'SECRET_FIXTURE_TOKEN' } }; })() } };
    installRunBudgetStreamGuard(eventSession, eventBudget);
    const forwarded = await drain(await eventSession.agent.streamFn(model, {}));
    expect(JSON.stringify(forwarded)).not.toContain('SECRET_FIXTURE_TOKEN');
  });
  it('rejects media injected by final payload overrides', async () => {
    const budget = createRunBudget(limits, model);
    const session: any = { agent: { streamFn: async (_m: any, _c: any, options: any) => {
      await options.onPayload({ max_completion_tokens: 100, modalities: ['text', 'audio'] }, model);
      throw new Error('must not dispatch');
    } } };
    installRunBudgetStreamGuard(session, budget);
    const events = await drain(await session.agent.streamFn(model, {}));
    expect(events.at(-1).error.errorMessage).toMatch(/media/);
    expect(budget.snapshot().state).toBe('blocked');
  });
  it('blocks unsupported media before the provider call', async () => {
    const original = vi.fn(); const budget = createRunBudget(limits, model);
    const session: any = { agent: { streamFn: original } }; installRunBudgetStreamGuard(session, budget);
    await expect(session.agent.streamFn(model, { messages: [{ content: [{ type: 'image' }] }] })).rejects.toThrow(/media/);
    expect(original).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });
});
