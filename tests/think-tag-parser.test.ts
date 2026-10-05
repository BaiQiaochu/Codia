import { describe, it, expect } from 'vitest';
import { ThinkTagParser } from '../core/events.js';

function collect(input) {
  const parser = new ThinkTagParser();
  const events = [];
  const chunks = Array.isArray(input) ? input : [input];
  for (const chunk of chunks) {
    parser.feed(chunk, (event) => events.push(event));
  }
  parser.flush((event) => events.push(event));
  return events;
}

describe('ThinkTagParser', () => {
  it('extracts paired think tags into thinking events', () => {
    expect(collect('<think>hidden</think>\nanswer')).toEqual([
      { type: 'think_start' },
      { type: 'think_text', data: 'hidden' },
      { type: 'think_end' },
      { type: 'text', data: 'answer' },
    ]);
  });

  it('extracts malformed think message delimiters into thinking events', () => {
    expect(collect('<think<|message|>hidden</think>\nanswer')).toEqual([
      { type: 'think_start' },
      { type: 'think_text', data: 'hidden' },
      { type: 'think_end' },
      { type: 'text', data: 'answer' },
    ]);
  });

  it('keeps malformed think message delimiters hidden when split across chunks', () => {
    expect(collect(['<thi', 'nk<|mes', 'sage|>hidden</thi', 'nk>\nanswer'])).toEqual([
      { type: 'think_start' },
      { type: 'think_text', data: 'hidden' },
      { type: 'think_end' },
      { type: 'text', data: 'answer' },
    ]);
  });

  it('removes orphan closing tags split across stream chunks', () => {
    expect(collect(['</thi', 'nk>\nanswer'])).toEqual([
      { type: 'text', data: 'answer' },
    ]);
  });

  it('treats text before a first orphan closing tag as hidden thinking', () => {
    expect(collect('hidden chain</think>\nanswer')).toEqual([
      { type: 'think_start' },
      { type: 'think_text', data: 'hidden chain' },
      { type: 'think_end' },
      { type: 'text', data: 'answer' },
    ]);
  });

  it('parses think tags case-insensitively', () => {
    expect(collect('<THINKING>hidden</THINKING>\nanswer')).toEqual([
      { type: 'think_start' },
      { type: 'think_text', data: 'hidden' },
      { type: 'think_end' },
      { type: 'text', data: 'answer' },
    ]);
  });

  it('extracts paired reflect tags into thinking events', () => {
    expect(collect('<reflect>hidden reflection</reflect>\nanswer')).toEqual([
      { type: 'think_start' },
      { type: 'think_text', data: 'hidden reflection' },
      { type: 'think_end' },
      { type: 'text', data: 'answer' },
    ]);
  });
});
