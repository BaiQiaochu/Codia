import { describe, expect, it } from 'vitest';
import { serializeChatMessageForCopy } from '../../utils/chat-copy';

describe('serializeChatMessageForCopy', () => {
  (globalThis as unknown as { window?: { t?: (key: string) => string } }).window = {
    t: (key: string) => {
      if (key === 'sidebar.jian') return 'Data Storage';
      return key;
    },
  };

  it('preserves order when copying mixed user and assistant messages together', () => {
    const messages = [
      {
        id: 'u1',
        role: 'user' as const,
        quotedText: 'quoted request',
        text: 'user body',
        attachments: [{ path: 'C:\\tmp\\doc.md', name: 'doc.md', isDir: false }],
      },
      {
        id: 'a1',
        role: 'assistant' as const,
        blocks: [
          { type: 'tool_group' as const, collapsed: false, tools: [{ name: 'read', done: true, success: true, args: { path: '/tmp/doc.md' } }] },
          { type: 'plugin_card' as const, card: { pluginId: 'image-gen', route: '/card?batch=1', title: 'Preview Card', description: 'card desc', type: 'text' } },
          { type: 'text' as const, html: '<p>assistant answer</p>' },
        ],
      },
    ];

    const copied = messages.map(serializeChatMessageForCopy).join('\n\n');

    expect(copied).toMatch(/quoted request[\s\S]*user body[\s\S]*doc\.md[\s\S]*read[\s\S]*Preview Card[\s\S]*assistant answer/);
  });

  it('keeps visible user message text such as quotes, skills, attachments, and desk context', () => {
    const text = serializeChatMessageForCopy({
      id: 'u1',
      role: 'user',
      quotedText: 'quoted line',
      skills: ['skill-a', 'skill-b'],
      text: 'hello world',
      attachments: [
        { path: 'C:\\tmp\\foo.txt', name: 'foo.txt', isDir: false },
        { path: 'C:\\tmp\\bar', name: 'bar', isDir: true },
      ],
      deskContext: { dir: 'C:\\desk', fileCount: 3 },
    });

    expect(text).toContain('quoted line');
    expect(text).toContain('skill-a skill-b');
    expect(text).toContain('hello world');
    expect(text).toContain('foo.txt');
    expect(text).toContain('bar');
    expect(text).toContain('Data Storage (3)');
  });

  it('keeps assistant text from non-text blocks that used to be dropped', () => {
    const text = serializeChatMessageForCopy({
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'mood', yuan: 'gsap', text: 'mood line' },
        { type: 'tool_group', collapsed: false, tools: [{ name: 'read', done: true, success: true, args: { path: '/tmp/a.txt' } }] },
        { type: 'artifact', artifactId: 'art-1', artifactType: 'markdown', title: 'Artifact Title', content: 'body' },
        { type: 'skill', skillName: 'Installed Skill', skillFilePath: '/tmp/test.skill' },
        { type: 'plugin_card', card: { pluginId: 'image-gen', route: '/card?batch=1', title: 'Image Card', description: 'Generated image', type: 'text' } },
        { type: 'text', html: '<p>final <strong>answer</strong></p>' },
      ],
    });

    expect(text).toContain('mood line');
    expect(text).toContain('read');
    expect(text).toContain('a.txt');
    expect(text).toContain('Artifact Title');
    expect(text).toContain('Installed Skill');
    expect(text).toContain('Image Card');
    expect(text).toContain('Generated image');
    expect(text).toContain('final answer');
  });
});
