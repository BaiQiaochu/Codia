import { describe, expect, it } from 'vitest';
import { WORKSPACE_TOOL_OPTIONS, readWorkspaceToolSelectionDetail } from '../../utils/workspace-tool-events';

describe('workspace tool events', () => {
  it('accepts only known workspace tool selections', () => {
    expect(readWorkspaceToolSelectionDetail({
      id: 'meeting',
      title: 'spoofed title',
      description: 'spoofed description',
    })).toEqual({
      id: 'meeting',
      title: '会议纪要',
      description: '转写、摘要、行动项、风险项',
    });

    expect(readWorkspaceToolSelectionDetail({
      id: 'browser',
      title: '浏览器',
      description: '打开网页',
    })).toBeNull();
    expect(readWorkspaceToolSelectionDetail({
      id: 'meeting',
      title: '',
      description: 'caller text is ignored',
    })).toEqual({
      id: 'meeting',
      title: '会议纪要',
      description: '转写、摘要、行动项、风险项',
    });
  });

  it('exposes the supported workspace tool menu options', () => {
    expect(WORKSPACE_TOOL_OPTIONS.map(option => option.id)).toEqual([
      'research',
      'documents',
      'meeting',
      'selection',
      'workflow-market',
    ]);
    expect(WORKSPACE_TOOL_OPTIONS.every(option => option.title && option.description)).toBe(true);
  });
});
