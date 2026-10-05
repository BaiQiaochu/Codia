import { describe, expect, it } from 'vitest';
import { splitAssistantMeta } from '../../utils/assistant-meta-parser';

describe('splitAssistantMeta', () => {
  it('moves leaked reasoning and plain MOOD into collapsible blocks', () => {
    const input = [
      'The user is asking me to think deeply, but no actual topic was given.',
      'I should ask for the missing topic instead of inventing one.',
      '',
      'MOOD. The gears are turning, but there is no subject yet.',
      '',
      'Tell me what topic you want me to think about.',
    ].join('\n');

    const result = splitAssistantMeta(input);

    expect(result.thinking).toContain('The user is asking me');
    expect(result.mood).toBe('The gears are turning, but there is no subject yet.');
    expect(result.moodYuan).toBe('gsap');
    expect(result.text).toBe('Tell me what topic you want me to think about.');
  });

  it('does not hide normal English replies without a MOOD boundary', () => {
    const input = 'The user guide is available in the Help menu.';

    expect(splitAssistantMeta(input)).toEqual({
      text: input,
      thinking: '',
      mood: null,
      moodYuan: null,
    });
  });

  it('folds untagged tool-planning monologue into thinking instead of visible text', () => {
    const input = [
      '`office-documents` skill... wait, did the system prompt say only use specific tools?',
      'Actually, many environments handle `.docx` through a backend reader.',
      'Current files:',
      '1. C:\\Users\\root\\.gsap\\uploads\\test.xlsx',
      'I will attempt to read both now using their verified paths.',
    ].join('\n');

    const result = splitAssistantMeta(input);

    expect(result.text).toBe('');
    expect(result.thinking).toContain('office-documents');
    expect(result.thinking).toContain('Current files:');
  });

  it('folds leaked pseudo tool calls into the thinking block', () => {
    const input = [
      'The user is asking me to check the skill directory.',
      'Let me inspect the available skill first.',
      '<find>',
      '<parameter=pattern>',
      '/project-manager',
      '</parameter>',
      '</find>',
      '</tool_call>',
    ].join('\n');

    const result = splitAssistantMeta(input);

    expect(result.thinking).toContain('The user is asking me');
    expect(result.thinking).toContain('<parameter=pattern>');
    expect(result.text).toBe('');
    expect(result.mood).toBeNull();
  });

  it('keeps existing think tags hidden', () => {
    const result = splitAssistantMeta('<think>hidden chain</think>\nvisible answer');

    expect(result.thinking).toBe('hidden chain');
    expect(result.text).toBe('visible answer');
  });

  it('folds malformed think message delimiters into the thinking block', () => {
    const result = splitAssistantMeta('<think<|message|>hidden chain</think>\nvisible answer');

    expect(result.thinking).toBe('hidden chain');
    expect(result.text).toBe('visible answer');
  });

  it('folds reflect tags into the thinking block', () => {
    const result = splitAssistantMeta('<reflect>hidden reflection</reflect>\nvisible answer');

    expect(result.thinking).toBe('hidden reflection');
    expect(result.text).toBe('visible answer');
    expect(result.mood).toBeNull();
    expect(result.moodYuan).toBeNull();
  });

  it('folds plain REFLECT prefixes into the thinking block', () => {
    const result = splitAssistantMeta('REFLECT. hidden reflection\n\nvisible answer');

    expect(result.thinking).toBe('hidden reflection');
    expect(result.text).toBe('visible answer');
    expect(result.mood).toBeNull();
    expect(result.moodYuan).toBeNull();
  });

  it('treats plain MOD as a MOOD-compatible collapsible block', () => {
    const result = splitAssistantMeta('MOD. hidden mod line\n\nvisible answer');

    expect(result.mood).toBe('hidden mod line');
    expect(result.moodYuan).toBe('gsap');
    expect(result.text).toBe('visible answer');
  });

  it('treats plain HERMES as a collapsible block', () => {
    const result = splitAssistantMeta('HERMES. loop summary\n\nvisible answer');

    expect(result.mood).toBe('loop summary');
    expect(result.moodYuan).toBe('hermes');
    expect(result.text).toBe('visible answer');
  });

  it('treats plain HERMES LOOP as a collapsible block', () => {
    const result = splitAssistantMeta('HERMES LOOP: reusable lesson\n\nvisible answer');

    expect(result.mood).toBe('reusable lesson');
    expect(result.moodYuan).toBe('hermes');
    expect(result.text).toBe('visible answer');
  });

  it('treats a bare MOOD heading line as a collapsible block', () => {
    const input = [
      'MOOD',
      '',
      '核心材料齐全，门禁通过。开始执行完整工作流。',
      '',
      '这里是正式回答。',
    ].join('\n');

    const result = splitAssistantMeta(input);

    expect(result.mood).toBe('核心材料齐全，门禁通过。开始执行完整工作流。');
    expect(result.moodYuan).toBe('gsap');
    expect(result.text).toBe('这里是正式回答。');
  });

  it('treats a bare MOD heading line as a MOOD-compatible block', () => {
    const input = [
      'MOD',
      '',
      '先把环境探一遍，再动手。',
      '',
      '这是外显回复。',
    ].join('\n');

    const result = splitAssistantMeta(input);

    expect(result.mood).toBe('先把环境探一遍，再动手。');
    expect(result.moodYuan).toBe('gsap');
    expect(result.text).toBe('这是外显回复。');
  });

  it('keeps the original text when a bare MOOD marker has no body', () => {
    expect(splitAssistantMeta('MOOD\n\n')).toEqual({
      text: 'MOOD\n\n',
      thinking: '',
      mood: null,
      moodYuan: null,
    });
  });
});
