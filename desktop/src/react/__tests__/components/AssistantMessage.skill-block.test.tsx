// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  openSkillPreview: vi.fn(),
}));

vi.mock('../../utils/file-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/file-preview')>();
  return {
    ...actual,
    openSkillPreview: mocks.openSkillPreview,
  };
});

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

describe('AssistantMessage skill blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.t = ((key: string) => key) as typeof window.t;
    (window as any).platform = {
      getFileUrl: (filePath: string) => `file://${filePath}`,
      startDrag: vi.fn(),
    };
    useStore.setState({
      agents: [],
      agentName: 'G-SAP',
      agentYuan: 'gsap',
      mediaViewer: null,
      streamingSessions: [],
      selectedMessageIdsBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as any).platform;
  });

  it('opens the installed skill preview from the chat resource card', () => {
    const installedSkillSource = {
      kind: 'skill_source',
      owner: 'user',
      skillName: 'university-info',
      baseDir: '/Users/example/.gsap/skills/university-info',
      filePath: '/Users/example/.gsap/skills/university-info/SKILL.md',
      editable: true,
      readonly: false,
    };

    render(
      <AssistantMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{
          id: 'a-skill',
          role: 'assistant',
          blocks: [{
            type: 'skill',
            skillName: 'university-info',
            skillFilePath: '/stale/university-info/SKILL.md',
            installedSkillSource,
          }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'university-info' }));

    expect(mocks.openSkillPreview).toHaveBeenCalledTimes(1);
    expect(mocks.openSkillPreview).toHaveBeenCalledWith(
      'university-info',
      '/Users/example/.gsap/skills/university-info/SKILL.md',
      installedSkillSource,
    );
  });
});
