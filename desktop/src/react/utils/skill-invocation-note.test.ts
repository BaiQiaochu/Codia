import { describe, expect, it } from 'vitest';
import { parseSkillInvocationNote, stripSkillInvocationNote } from './skill-invocation-note';

describe('stripSkillInvocationNote', () => {
  it('keeps the user request while hiding the internal skill envelope', () => {
    const value = [
      '<available_skills>',
      '- name: user-guide',
      '  skill_md_path: C:\\skills\\user-guide\\SKILL.md',
      '</available_skills>',
      '<selected-skills>',
      'Use the selected skill.',
      '</selected-skills>',
      '这个是什么',
    ].join('\n');

    expect(stripSkillInvocationNote(value)).toBe('这个是什么');
  });

  it('recovers deduplicated skill identifiers without exposing instructions or paths', () => {
    const envelope = '<available_skills>\n- name: user-guide\n  skill_md_path: C:\\skills\\guide.md\n- name: user-guide\n- name: office-documents\n</available_skills>\n<selected-skills>Internal instructions</selected-skills>\n请帮我';
    expect(parseSkillInvocationNote(envelope)).toEqual({ text: '请帮我', skills: ['user-guide', 'office-documents'] });
    expect(parseSkillInvocationNote(envelope.replaceAll('\n', '\r\n')).skills).toEqual(['user-guide', 'office-documents']);
    expect(parseSkillInvocationNote(null)).toEqual({ text: '', skills: [] });
  });
});
