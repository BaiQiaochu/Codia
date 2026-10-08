import { describe, expect, it } from 'vitest';
import { findFileMentionTrigger, isFileMentionBoundaryChar } from '../../utils/file-mention-trigger';

describe('file mention trigger', () => {
  it('allows mentions at line start', () => {
    expect(findFileMentionTrigger('@README')).toEqual({
      atIndex: 0,
      query: 'README',
    });
  });

  it('allows mentions after whitespace', () => {
    expect(findFileMentionTrigger('open @README')).toEqual({
      atIndex: 5,
      query: 'README',
    });
  });

  it('allows mentions after punctuation and digits', () => {
    expect(findFileMentionTrigger('21312@README')).toEqual({
      atIndex: 5,
      query: 'README',
    });
    expect(findFileMentionTrigger('check:@README')).toEqual({
      atIndex: 6,
      query: 'README',
    });
  });

  it('allows mentions after CJK text without requiring whitespace', () => {
    expect(findFileMentionTrigger('查看@README')).toEqual({
      atIndex: 2,
      query: 'README',
    });
  });

  it('blocks email-like text', () => {
    expect(findFileMentionTrigger('name@example')).toBeNull();
    expect(findFileMentionTrigger('abc_def@README')).toBeNull();
  });

  it('blocks completed tokens with whitespace after @ query', () => {
    expect(findFileMentionTrigger('open @README now')).toBeNull();
    expect(findFileMentionTrigger('open @@README')).toBeNull();
  });

  it('uses the same boundary policy helper', () => {
    expect(isFileMentionBoundaryChar(undefined)).toBe(true);
    expect(isFileMentionBoundaryChar(' ')).toBe(true);
    expect(isFileMentionBoundaryChar('2')).toBe(true);
    expect(isFileMentionBoundaryChar('。')).toBe(true);
    expect(isFileMentionBoundaryChar('A')).toBe(false);
  });
});
