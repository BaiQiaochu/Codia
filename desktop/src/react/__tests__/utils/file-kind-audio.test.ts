import { describe, expect, it } from 'vitest';
import { inferKindByExt, isAudioFileName, kindOfFileName } from '../../utils/file-kind';

describe('file-kind audio compatibility', () => {
  it('recognizes upstream audio extensions and audio mime types', () => {
    expect(inferKindByExt('weba')).toBe('audio');
    expect(kindOfFileName('recording.bin', 'audio/webm')).toBe('audio');
    expect(isAudioFileName('clip.weba')).toBe(true);
  });
});
