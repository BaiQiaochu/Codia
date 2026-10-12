import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('InputArea prompt queue wiring', () => {
  it('queues prompts with attachments, quotes, and skills through the normal prompt path', () => {
    const source = read('components/InputArea.tsx');
    const styles = read('components/input/InputArea.module.css');

    expect(source).toContain('interface QueuedPrompt');
    expect(source).toContain('files: AttachedFile[]');
    expect(source).toContain('quotedSelections: QuotedSelection[]');
    expect(source).toContain('skills: string[]');
    expect(source).toContain('draft.plugins.map');
    expect(source).toContain('workspaceTool: WorkspaceToolSelection | null');
    expect(source).toContain("if (item.workspaceTool?.title) parts.push(`工具 ${item.workspaceTool.title}`);");
    expect(source).toContain('const workspaceTool = useStore(s => s.workspaceTool);');
    expect(source).toContain('const setWorkspaceTool = useStore(s => s.setWorkspaceTool);');
    expect(source).not.toContain('useState<WorkspaceToolSelection | null>');
    expect(source).toContain("status: 'pending' | 'running' | 'failed'");
    expect(source).toContain('queueStats');
    expect(source).toContain('queueStatusLabel');
    expect(source).toContain('retryQueuedMessage');
    expect(source).toContain('cancelQueueRun');
    expect(source).toContain('const [queuedMessages, setQueuedMessages]');
    expect(source).toContain('const handleQueueAdd = useCallback');
    expect(source).toContain('const draft = createPromptDraft(text, skills, inputFiles, references);');
    expect(source).toContain('workspaceTool: workspaceTool ? { ...workspaceTool } : null');
    expect(source).not.toContain('queueTextOnly');
    expect(source).toContain('const handleQueueDrop = useCallback');
    expect(source).toContain('visibleQueuedMessages');
    expect(source).toContain('hiddenQueuedMessageCount');
    expect(source).toContain('const ok = await sendPromptDraft(next);');
    expect(source).toContain('buildPromptWsMessage');
    expect(source).toContain('collectUiContext(useStore.getState(), { workspaceTool: draft.workspaceTool })');
    expect(source).toContain('workspaceTool: draft.workspaceTool || undefined');
    expect(source).toContain('plugins: draft.plugins.length > 0');
    expect(source).toContain('const activeWorkspaceTool = workspaceTool ? { ...workspaceTool } : null;');
    expect(source).toContain('collectUiContext(useStore.getState(), { workspaceTool: activeWorkspaceTool })');
    expect(source).toContain("import { streamBufferManager } from '../hooks/use-stream-buffer';");
    expect(source).toContain('streamBufferManager.beginUserTurn(targetSessionPath);');
    expect(source).toContain('if (isStreaming) {');
    expect(source).toContain('enqueuePromptDraft(draft);');
    expect(source).toContain('<SendButton isStreaming={isStreaming} hasInput={hasContent}');
    expect(source).not.toContain("t('input.queueAdd')");
    expect(styles).toContain('.prompt-queue-panel');
    expect(styles).toContain('.prompt-queue-summary');
    expect(styles).toContain('.prompt-queue-error');
    expect(styles).toContain('.prompt-queue-overflow');
    expect(styles).toContain('[data-status="failed"]');
    expect(styles).not.toContain('.queue-add-btn');
  });

  it('keeps prompt drafts readable in a compact horizontal queue without covering the chat', () => {
    const styles = read('components/input/InputArea.module.css');

    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('overflow-y: hidden;');
    expect(styles).toContain('width: clamp(150px, 24vw, 230px);');
    expect(styles).toContain('scrollbar-width: thin;');
    expect(styles).not.toContain('scrollbar-width: none;');
  });

  it('renders the queue panel above the input card instead of inside the composer row', () => {
    const source = read('components/InputArea.tsx');
    const styles = read('components/input/InputArea.module.css');
    const queuePanelIndex = source.indexOf("data-prompt-queue-panel");
    const inputStackIndex = source.indexOf("styles['input-stack']");

    expect(queuePanelIndex).toBeGreaterThan(-1);
    expect(inputStackIndex).toBeGreaterThan(-1);
    expect(queuePanelIndex).toBeLessThan(inputStackIndex);
    expect(styles).toMatch(/\.input-surface\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/);
    expect(styles).toMatch(/\.prompt-queue-panel\s*\{[\s\S]*align-self:\s*stretch;/);
  });

  it('uses session-scoped streaming state so queued sends show in session-id keyed chats', () => {
    const source = read('components/InputArea.tsx');

    expect(source).toMatch(/import\s+\{[^}]*selectIsStreamingSession[^}]*\}\s+from '..\/stores\/session-selectors';/);
    expect(source).toContain('const isStreaming = useStore(s => selectIsStreamingSession(s, s.currentSessionPath));');
    expect(source).toContain('if (selectIsStreamingSession(_s, _s.currentSessionPath)) return false;');
    expect(source).not.toContain("toStringArray(s.streamingSessions).includes(s.currentSessionPath || '')");
    expect(source).not.toContain("toStringArray(_s.streamingSessions).includes(_s.currentSessionPath || '')");
  });

  it('queues drafts during the send-to-stream handoff window instead of dropping them', () => {
    const source = read('components/InputArea.tsx');

    expect(source).toContain('if (isStreaming || sending || queueWaitingForResponse) {');
    expect(source).toMatch(/\}, \[[^\]]*queueWaitingForResponse[\s\S]*\]\);/);
  });
});
