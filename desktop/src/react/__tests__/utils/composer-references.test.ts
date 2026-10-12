import { describe, it, expect } from 'vitest';
import { serializeEditor } from '../../utils/editor-serializer';

describe('structured task and mention badges', () => {
  it.each(['ideas', 'code', 'workflow', 'agents'])('keeps %s separate from visible prose', actionId => {
    const result = serializeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'quickActionBadge', attrs: { actionId } },
      { type: 'skillBadge', attrs: { name: 'office-documents' } },
      { type: 'text', text: '用户自己的任务' },
    ] }] });
    expect(result.text).toBe('用户自己的任务');
    expect(result.quickAction).toBe(actionId);
    expect(result.skills).toEqual(['office-documents']);
  });
  it('sends stable assistant/session IDs without exposing history JSONL paths', () => {
    const result = serializeEditor({ type: 'doc', content: [
      { type: 'agentBadge', attrs: { agentId: 'helper', label: '辅助助手' } },
      { type: 'sessionBadge', attrs: { sessionId: 'history', path: 'private/history.jsonl', label: '讨论' } },
    ] });
    expect(result.text).toBe('');
    expect(result.fileRefs).toEqual([]);
    expect(result.agentMentions).toEqual([{ agentId: 'helper', label: '辅助助手' }]);
    expect(result.sessionRefs).toEqual([{ sessionId: 'history', label: '讨论' }]);
  });
  it('keeps plugin invocations structured and out of the visible message text', () => {
    const result = serializeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'pluginBadge', attrs: { id: 'company', name: '企业助手' } },
      { type: 'text', text: '这个插件是做什么的？' },
    ] }] });

    expect(result.text).toBe('这个插件是做什么的？');
    expect(result.plugins).toEqual([{ id: 'company', name: '企业助手' }]);
  });
});
