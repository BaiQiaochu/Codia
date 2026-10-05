import { describe, expect, it } from 'vitest';
import { buildItemsFromHistory } from '../../utils/history-builder';

describe('buildItemsFromHistory user image restoration', () => {
  it('restores task badges, review status and references from server presentation metadata', () => {
    const items = buildItemsFromHistory({ messages: [{
      role: 'user', content: '我的问题', quickAction: 'agents',
      agentMentions: [{ agentId: 'helper', label: '伙伴' }], sessionRefs: [{ sessionId: 's1', label: '之前的讨论' }],
      agentReview: { requestId: 'r1', status: 'failed', reviewerAgentId: 'helper', reviewerAgentName: '伙伴', error: 'model failed' },
    }] });
    expect(items[0]).toMatchObject({ type: 'message', data: { text: '我的问题', quickAction: 'agents', agentReview: { status: 'failed' }, sessionRefs: [{ sessionId: 's1' }] } });
  });
  it('restores a selected skill as a badge when reopening a legacy session', () => {
    const items = buildItemsFromHistory({ messages: [{
      id: 'skill-turn', role: 'user',
      content: '<available_skills>\n- name: user-guide\n  skill_md_path: C:\\skills\\SKILL.md\n</available_skills>\n<selected-skills>Read the selected skill</selected-skills>\n这个是什么',
    }] });
    expect(items[0]).toMatchObject({ type: 'message', data: { text: '这个是什么', skills: ['user-guide'] } });
    expect(JSON.stringify(items)).not.toContain('skill_md_path');
  });

  it('preserves session entry ids and timestamps for replay routing', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: '0',
        entryId: 'entry-user-1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-05-15T10:00:00.000Z',
      } as never],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.id).toBe('0');
    expect(first.data.sourceEntryId).toBe('entry-user-1');
    expect(first.data.timestamp).toBe(Date.parse('2026-05-15T10:00:00.000Z'));
  });

  it('restores attached_image markers as hidden image attachments', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '[attached_image: /Users/test/.hanako/attachments/upload-abc.png]\n(看图)',
      }],
    });

    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('(看图)');
    expect(first.data.textHtml).not.toContain('attached_image');
    expect(first.data.attachments).toEqual([{
      path: '/Users/test/.hanako/attachments/upload-abc.png',
      name: 'upload-abc.png',
      isDir: false,
      visionAuxiliary: true,
    }]);
  });

  it('merges native image blocks into attached_image attachments', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: 'u1',
        role: 'user',
        content: '[attached_image: /Users/test/.hanako/attachments/upload-native.png]\n看看这个',
        images: [{ data: 'BASE64', mimeType: 'image/png' }],
      }],
    });

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.text).toBe('看看这个');
    expect(first.data.attachments).toEqual([{
      path: '/Users/test/.hanako/attachments/upload-native.png',
      name: 'upload-native.png',
      isDir: false,
      base64Data: 'BASE64',
      mimeType: 'image/png',
      visionAuxiliary: false,
    }]);
  });
});
