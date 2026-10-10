/**
  *
 *
  *
 */

import { codiaFetch } from '../../hooks/use-codia-fetch';
import { getWebSocket } from '../../services/websocket';
import { useStore } from '../../stores';
import { ensureSession } from '../../stores/session-actions';
import { sessionIdForPathFromLocatorState } from '../../stores/session-slice';

// ── Xing Prompt ──

function copy(t: (key: string) => string, key: string, fallback: string) {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

const isZh = window.i18n?.locale?.startsWith?.('zh') ?? true;

export const XING_PROMPT = isZh
  ? `回顾本次对话中我（用户）发送的消息，提取可复用的工作流程、偏好和纠正。

你必须先查阅 skill-creator 技能，按其中 "Capture Intent" 和 "Write the SKILL.md" 部分的流程操作。
只做到创建并安装为止，不需要做 eval、benchmark 或 description optimization。

最终调用 install_skill 工具将技能安装为自学技能（skill_content + skill_name 模式）。`
  : `Review the messages I (the user) sent in this session and extract reusable workflows, preferences, and corrections.

You must first consult the skill-creator skill, following its "Capture Intent" and "Write the SKILL.md" sections.
Only go as far as creating and installing; do not run evals, benchmarks, or description optimization.

Use the install_skill tool to install the skill as a learned skill (skill_content + skill_name mode).`;

// Slash Command Interface

export interface SlashItem {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  type: 'builtin' | 'skill';
  filePath?: string;
  baseDir?: string;
  execute: (args?: string) => Promise<void> | void;
}

export const MAX_SLASH_TRIGGER_LENGTH = 20;

export function parseSlashInput(text: string): { name: string; args: string } {
  const normalized = text.trim();
  if (!normalized.startsWith('/')) return { name: '', args: '' };
  const body = normalized.slice(1);
  const spaceIdx = body.indexOf(' ');
  if (spaceIdx === -1) return { name: body.toLowerCase(), args: '' };
  return {
    name: body.slice(0, spaceIdx).toLowerCase(),
    args: body.slice(spaceIdx + 1).trim(),
  };
}

export function getSlashMatches(text: string, commands: SlashItem[]): SlashItem[] {
  const normalized = text.trim();
  if (!normalized.startsWith('/')) return [];
  const query = parseSlashInput(normalized).name;
  if (query.length > MAX_SLASH_TRIGGER_LENGTH) return [];
  if (!query) return commands;
  return commands.filter(command => command.name.startsWith(query));
}

export function buildSlashDraftText(commandName: string, text: string): string {
  const normalizedCommand = `/${String(commandName || '').trim().replace(/^\/+/, '')}`;
  if (normalizedCommand === '/') return '/';

  const raw = String(text || '');
  const trimmed = raw.trim();

  if (!trimmed || trimmed === '/') return `${normalizedCommand} `;

  const parsed = parseSlashInput(trimmed);
  if (!parsed.name) return `${normalizedCommand} `;

  return parsed.args
    ? `${normalizedCommand} ${parsed.args}`
    : `${normalizedCommand} `;
}

export function resolveSlashSubmitSelection({
  text,
  skills,
  commands,
  selectedIndex,
  dismissedText,
}: {
  text: string;
  skills: string[];
  commands: SlashItem[];
  selectedIndex: number;
  dismissedText: string | null;
}): SlashItem | null {
  if (skills.length > 0) return null;
  const matches = getSlashMatches(text, commands);
  if (matches.length === 0) return null;
  if (dismissedText === text.trim()) return null;
  return matches[selectedIndex] || matches[0] || null;
}

// ── Command Executors ──

async function resolveCurrentSessionPath(): Promise<string | null> {
  const state = useStore.getState();
  if (state.currentSessionPath) return state.currentSessionPath;
  const ok = await ensureSession();
  if (!ok) return null;
  return useStore.getState().currentSessionPath || null;
}

function currentSessionIdForPath(sessionPath: string): string | null {
  return sessionIdForPathFromLocatorState(useStore.getState(), sessionPath);
}

export function executeDiary(
  t: (key: string) => string,
  showResult: (text: string, type: 'success' | 'error') => void,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('diary');
    setInput('');
    setMenuOpen(false);
    try {
      const res = await codiaFetch('/api/diary/write', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        showResult(data.error || t('slash.diaryFailed'), 'error');
        return;
      }
      showResult(t('slash.diaryDone'), 'success');
    } catch {
      showResult(t('slash.diaryFailed'), 'error');
    }
  };
}

export function executeCompact(
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('compact');
    setInput('');
    setMenuOpen(false);
    try {
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        const sessionPath = await resolveCurrentSessionPath();
        if (sessionPath) {
          ws.send(JSON.stringify({ type: 'compact', sessionPath }));
        }
      }
    } finally {
      setTimeout(() => setBusy(null), 1500);
    }
  };
}

export function executeSlashViaWs(
  cmd: string,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy(cmd);
    setInput('');
    setMenuOpen(false);
    try {
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        const sessionPath = await resolveCurrentSessionPath();
        if (!sessionPath) return;
        const sessionId = currentSessionIdForPath(sessionPath);
        ws.send(JSON.stringify({
          type: 'slash',
          text: '/' + cmd,
          sessionPath,
          ...(sessionId ? { sessionId } : {}),
        }));
      }
    } finally {
      setTimeout(() => setBusy(null), 800);
    }
  };
}

export function buildVideoCommandPrompt(task: string): string {
  const trimmed = String(task || '').trim();
  if (!trimmed) return '';
  return `Call the image-gen_generate-video tool directly for the video generation task below. Do not paraphrase first and do not ask environment questions first.

Task:
${trimmed}

Requirements:
- Use the default video model from Media settings unless the user explicitly names a provider or model
- Submit the task first and return a progress card
- If no video provider is available, explain that a default video model must be configured in Settings > Media`;
}

export function executeVideo(
  t: (key: string) => string,
  showResult: (text: string, type: 'success' | 'error') => void,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
  sendAsUser: (text: string, displayText?: string) => Promise<boolean>,
): (args?: string) => Promise<void> {
  return async (args = '') => {
    const task = String(args || '').trim();
    if (!task) {
      showResult(copy(t, 'slash.videoNeedTask', 'Add a video prompt after /video'), 'error');
      return;
    }

    setBusy('video');
    setInput('');
    setMenuOpen(false);
    try {
      const ok = await sendAsUser(buildVideoCommandPrompt(task), `/video ${task}`);
      if (!ok) {
        showResult(copy(t, 'slash.videoFailed', 'Video task submission failed'), 'error');
        return;
      }
      setTimeout(() => setBusy(null), 400);
    } catch {
      showResult(copy(t, 'slash.videoFailed', 'Video task submission failed'), 'error');
    }
  };
}

export function buildSlashCommands(
  t: (key: string) => string,
  executeDiaryFn: () => Promise<void>,
  executeXingFn: () => Promise<void>,
  executeCompactFn: () => Promise<void>,
  executeVideoFn: (args?: string) => Promise<void>,
  slashViaWsFactory?: (cmd: string) => () => Promise<void>,
): SlashItem[] {
  const list: SlashItem[] = [
    {
      name: 'diary',
      label: '/diary',
      description: t('slash.diary'),
      busyLabel: t('slash.diaryBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      type: 'builtin',
      execute: executeDiaryFn,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('slash.xing'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
      type: 'builtin',
      execute: executeXingFn,
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('slash.compact'),
      busyLabel: t('slash.compactBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
      type: 'builtin',
      execute: executeCompactFn,
    },
  ];
  if (slashViaWsFactory) {
    list.push(
      {
        name: 'stop',
        label: '/stop',
        description: t('slash.stop'),
        busyLabel: '',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
        type: 'builtin',
        execute: slashViaWsFactory('stop'),
      },
      {
        name: 'new',
        label: '/new',
        description: t('slash.new'),
        busyLabel: '',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
        type: 'builtin',
        execute: slashViaWsFactory('new'),
      },
      {
        name: 'reset',
        label: '/reset',
        description: t('slash.reset'),
        busyLabel: '',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>',
        type: 'builtin',
        execute: slashViaWsFactory('reset'),
      },
    );
  }
  list.push(
    {
      name: 'video',
      label: '/video',
      description: copy(t, 'slash.video', 'Generate video'),
      busyLabel: copy(t, 'slash.videoBusy', 'Submitting video task...'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="15" height="14" rx="2"/><polygon points="23 7 16 12 23 17 23 7"/></svg>',
      type: 'builtin',
      execute: executeVideoFn,
    },
  );
  return list;
}
