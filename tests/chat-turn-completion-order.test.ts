import { describe, expect, it, vi } from 'vitest';
import { createChatRoute } from '../server/routes/chat.ts';

describe('chat completion and runtime cleanup order', () => {
  it.each(['reply', ''])('keeps the turn busy until runtime cleanup completes (%j)', (text) => {
    let subscribe: (event: any, path: string) => void;
    let createHandlers: (context: any) => any;
    let busy = true;
    const sessionPath = '/agents/a/sessions/cleanup.jsonl';
    const engine = {
      isSessionStreaming: () => busy,
      getSessionByPath: () => ({ entries: [] }),
    };
    const hub = {
      subscribe: vi.fn((callback) => { subscribe = callback; }),
      eventBus: { emit: vi.fn() },
    };
    createChatRoute(engine, hub, {
      upgradeWebSocket: (factory) => { createHandlers = factory; return () => new Response(null); },
    });
    const handlers = createHandlers!({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    const messages = () => ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    subscribe!({ type: 'session_status', isStreaming: true }, sessionPath);
    if (text) subscribe!({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }, sessionPath);

    // The SDK finishes generating before prompt cleanup releases its busy lock.
    subscribe!({ type: 'turn_end' }, sessionPath);
    subscribe!({ type: 'session_status', isStreaming: false }, sessionPath);
    expect(messages().filter((event) => event.type === 'turn_end')).toHaveLength(0);
    expect(messages().filter((event) => event.type === 'status' && !event.isStreaming)).toHaveLength(0);

    busy = false;
    subscribe!({ type: 'session_status', isStreaming: false }, sessionPath);
    subscribe!({ type: 'turn_end' }, sessionPath);
    expect(messages().filter((event) => event.type === 'turn_end')).toHaveLength(1);
    expect(messages().at(-1)).toMatchObject({ type: 'status', isStreaming: false, sessionPath });
    expect(messages().filter((event) => event.type === 'error')).toHaveLength(text ? 0 : 1);
    handlers.onClose({}, ws);
  });
});
