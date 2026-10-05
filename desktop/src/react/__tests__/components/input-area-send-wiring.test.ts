import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('InputArea send wiring', () => {
  it('keeps editor text, React state, and WebSocket send state in sync', () => {
    const source = read('components/InputArea.tsx');

    expect(source).toMatch(/const clearEditor = useCallback\(\(\) => \{[\s\S]*?editor\?\.commands\.clearContent\(\);[\s\S]*?setInputText\(''\);[\s\S]*?\}, \[editor\]\);/);
    expect(source).toMatch(/editor\.commands\.setContent\(buildPlainTextEditorDoc\(draft\), \{ emitUpdate: false \}\);[\s\S]*?setInputText\(draft\);/);
    expect(source).toMatch(/e2e\.setInputText = \(text: string\) => \{[\s\S]*?setInputText\(text\);[\s\S]*?return editor\.getText\(\);/);
    expect(source).toContain('if (!editor.isEditable) editor.setEditable(true);');
    expect(source).toContain('onMouseDown={focusEditorFromInputShell}');
    expect(source).toContain('selectSessionFiles(s, s.currentSessionPath) : EMPTY_ARRAY');
    expect(source).toContain('evaluateChatVideoSendPreflight');
    expect(source).toContain('notifyTextModelVideoFileOnly');
    expect(source).toContain('chatVideoMimeTypeForName');
    expect(source).toContain('const videoFiles = inputFiles.filter');
    expect(source).toContain('const sendVideosNatively = videoPreflight.ok && videoPreflight.reason ===');
    expect(source).toContain('const videosAsFileOnly = !sendVideosNatively');
    expect(source).toContain('notifyTextModelVideoFileOnly');
    expect(source).toContain('for (const video of sendVideosNatively ? videoFiles : [])');
    expect(source).toContain('!(sendVideosNatively && isVideoFile(f.name))');
    expect(source).toContain('const sessionFileRefs = inputFiles');
    expect(source).toContain('wsMsg.sessionFileRefs = sessionFileRefs');
    expect(source).toContain('wsMsg.videos');
    expect(source).toContain('submitChatVideoGeneration');
    expect(source).toContain('activeChatVideoMode');
    expect(source).toContain('onChatVideoModeChange={setActiveChatVideoMode}');
    expect(source).toMatch(/if \(activeChatVideoMode\)[\s\S]*submitChatVideoGeneration/);
    expect(source).toContain("import { requestPromptOptimization } from '../utils/prompt-optimizer';");
    expect(source).toContain("import { requestResearchReport } from '../utils/research-mode';");
    expect(source).toContain('const [promptOptimizing, setPromptOptimizing] = useState(false);');
    expect(source).toContain('const [researching, setResearching] = useState(false);');
    expect(source).toContain('const handleOptimizePrompt = useCallback(async () => {');
    expect(source).toContain('requestPromptOptimization({');
    expect(source).toContain('const handleResearchPrompt = useCallback(async () => {');
    expect(source).toContain('requestResearchReport({');
    expect(source).toContain('setEditorPlainText(optimized);');
    expect(source).toContain('setEditorPlainText(result.report);');
    expect(source).toContain('data-testid="research-mode-button"');
    expect(source).toContain('data-testid="prompt-optimize-button"');
    expect(source).toContain("title={t('input.researchMode')}");
    expect(source).toContain("title={t('input.promptOptimize')}");
    expect(source).toContain('disabled={deletedAgentReadOnly || researching || promptOptimizing || !inputText.trim()}');
    expect(source).toContain('disabled={deletedAgentReadOnly || promptOptimizing || researching || !inputText.trim()}');
    expect(source).toContain('const selectedAgentId = useStore(s => s.selectedAgentId);');
    expect(source).toContain('const slashAgentId = pendingNewSession ? (selectedAgentId || currentAgentId) : currentAgentId;');
    expect(source).toContain("const skillItems = useSkillSlashItems({ enabled: surface !== 'mobile', agentId: slashAgentId });");
    expect(source).toContain('const storedSessionConfirmation = useStore(s => s.currentSessionPath');
    expect(source).toContain('sessionScopedValue(s, s.pendingSessionConfirmationsByPath, s.currentSessionPath) || null');
    expect(source).toMatch(/findLatestInputSessionConfirmation\(currentSessionItems, undefined, true\)[\s\S]*\|\| storedSessionConfirmation/);
    expect(source).toContain('handleKeyDown: (_view, event) => keyDownHandlerRef.current(event)');
    expect(source).toMatch(/if \(e\.key === 'Enter' && !e\.shiftKey[\s\S]*?e\.preventDefault\(\);[\s\S]*?return true;/);
    expect(source).toContain('if (!ws || ws.readyState !== WebSocket.OPEN) return;');
    expect(source).toContain('ws.send(JSON.stringify(wsMsg));');
    expect(source).not.toContain('ws?.send(JSON.stringify(wsMsg));');
  });

  it('starts a fresh stream buffer turn before sending injected user prompts', () => {
    const source = read('components/InputArea.tsx');
    const sendAsUserBlock = source.match(/const sendAsUser = useCallback[\s\S]*?ws\.send\(JSON\.stringify\(\{[\s\S]*?type: 'prompt'/)?.[0] || '';

    expect(sendAsUserBlock).toContain('streamBufferManager.beginUserTurn(targetSessionPath);');
    expect(sendAsUserBlock.indexOf('streamBufferManager.beginUserTurn(targetSessionPath);')).toBeLessThan(
      sendAsUserBlock.indexOf('ws.send(JSON.stringify'),
    );
  });

  it('creates a session before sending when the current session path is missing', () => {
    const source = read('components/InputArea.tsx');
    const slashCommandsSource = read('components/input/slash-commands.ts');
    const chatVideoSource = read('components/input/chat-video-mode.ts');
    const sendPromptDraftBlock = source.match(/const sendPromptDraft = useCallback[\s\S]*?ws\.send\(JSON\.stringify\(wsMsg\)\);/)?.[0] || '';
    const sendAsUserBlock = source.match(/const sendAsUser = useCallback[\s\S]*?ws\.send\(JSON\.stringify\(\{[\s\S]*?type: 'prompt'/)?.[0] || '';
    const slashResolveBlock = slashCommandsSource.match(/async function resolveCurrentSessionPath\(\): Promise<string \| null> \{[\s\S]*?\n\}/)?.[0] || '';
    const chatVideoResolveBlock = chatVideoSource.match(/async function resolveCurrentSessionPath\(\): Promise<string \| null> \{[\s\S]*?\n\}/)?.[0] || '';

    expect(sendPromptDraftBlock).toContain('!sessionState.currentSessionPath || sessionState.pendingNewSession');
    expect(sendPromptDraftBlock.indexOf('ensureSession()')).toBeLessThan(
      sendPromptDraftBlock.indexOf('buildPromptWsMessage'),
    );
    expect(sendAsUserBlock).toContain('!sessionState.currentSessionPath || sessionState.pendingNewSession');
    expect(sendAsUserBlock.indexOf('ensureSession()')).toBeLessThan(
      sendAsUserBlock.indexOf('ws.send(JSON.stringify'),
    );
    expect(slashResolveBlock).toContain('const ok = await ensureSession();');
    expect(slashResolveBlock).not.toContain('if (state.pendingNewSession)');
    expect(chatVideoResolveBlock).toContain('const ok = await ensureSession();');
    expect(chatVideoResolveBlock).not.toContain('if (state.pendingNewSession)');
  });
});
