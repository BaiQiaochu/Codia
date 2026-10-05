import {
  dispatchCoverNotice,
  requestMarkdownCoverGeneration,
} from './markdown-cover-generation';
import { gsapFetch } from '../hooks/use-gsap-fetch';

let activeGuidanceDialog: { close: (value: string | null) => void } | null = null;

type CoverGenerationStatus = {
  enabled?: boolean;
  executorAgentId?: string | null;
  disabledReason?: string | null;
  message?: string | null;
};

type CoverStatus = {
  agentGenerate?: CoverGenerationStatus;
  enabled?: boolean;
  agentId?: string | null;
};

export function isExternalCoverImagePath(imagePath: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(imagePath) && !/^[A-Za-z]:[\\/]/.test(imagePath);
}

function tr(key: string, fallback: string): string {
  const t = window.t ?? ((p: string) => p);
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function localBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'cover.png';
}

function joinLocalPath(dirPath: string, fileName: string): string {
  const sep = dirPath.includes('\\') && !dirPath.includes('/') ? '\\' : '/';
  return `${dirPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
}

function getAgentGenerateDisabledText(status: CoverGenerationStatus): string {
  if (status.message) return status.message;
  switch (status.disabledReason) {
    case 'beautify-disabled':
      return tr('cover.agentGenerate.beautifyDisabled', '文档美化工具已在助理工具设置中关闭。');
    case 'default-image-model-missing':
      return tr('cover.agentGenerate.defaultModelMissing', '尚未配置默认图片模型。');
    case 'default-image-model-invalid':
      return tr('cover.agentGenerate.defaultModelInvalid', '默认图片模型不可用。');
    case 'image-gen-unavailable':
      return tr('cover.agentGenerate.imageGenUnavailable', '图片生成运行时不可用。');
    case 'agent-unavailable':
      return tr('cover.agentGenerate.agentUnavailable', '当前助理不可用。');
    default:
      return tr('cover.agentGenerate.disabled', 'AI 生成当前不可用。');
  }
}

async function readCoverGenerationStatus(): Promise<CoverStatus> {
  const res = await gsapFetch('/api/desk/beautify/status');
  return await res.json().catch(() => ({}));
}

function ensureCoverPromptDialogStyles(): void {
  if (document.getElementById('markdown-cover-prompt-dialog-styles')) return;
  const style = document.createElement('style');
  style.id = 'markdown-cover-prompt-dialog-styles';
  style.textContent = `
.markdown-cover-prompt-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg, #101216) 18%, transparent);
  backdrop-filter: blur(6px);
}
.markdown-cover-prompt-dialog {
  box-sizing: border-box;
  width: min(420px, 100%);
  padding: 18px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.28));
  border-radius: 8px;
  background: var(--bg-card, #ffffff);
  color: var(--text, #111827);
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.2);
  font: 13px/1.5 var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
.markdown-cover-prompt-title {
  margin: 0 0 10px;
  color: var(--text, #111827);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0;
}
.markdown-cover-prompt-dialog textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.4));
  border-radius: 6px;
  resize: vertical;
  background: var(--bg, #ffffff);
  color: var(--text, #111827);
  font: inherit;
  outline: none;
}
.markdown-cover-prompt-dialog textarea:focus {
  border-color: color-mix(in srgb, var(--accent, #2563eb) 72%, var(--border, rgba(148, 163, 184, 0.4)));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #2563eb) 18%, transparent);
}
.markdown-cover-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.markdown-cover-prompt-actions button {
  min-height: 34px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.36));
  background: var(--bg-card, #ffffff);
  color: var(--text, #111827);
  font: inherit;
  cursor: pointer;
}
.markdown-cover-prompt-actions button:hover {
  background: var(--overlay-subtle, rgba(148, 163, 184, 0.12));
}
.markdown-cover-prompt-actions .markdown-cover-prompt-primary {
  border-color: color-mix(in srgb, var(--accent, #2563eb) 76%, transparent);
  background: var(--accent, #2563eb);
  color: var(--accent-contrast, #ffffff);
}
.markdown-cover-prompt-actions .markdown-cover-prompt-primary:hover {
  background: color-mix(in srgb, var(--accent, #2563eb) 88%, #000000);
}
`;
  document.head.appendChild(style);
}

export function requestMarkdownCoverGuidance(): Promise<string | null> {
  activeGuidanceDialog?.close(null);
  ensureCoverPromptDialogStyles();

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'markdown-cover-prompt-overlay';

    const form = document.createElement('form');
    form.className = 'markdown-cover-prompt-dialog';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    form.setAttribute('aria-labelledby', 'markdown-cover-prompt-title');

    const title = document.createElement('h2');
    title.id = 'markdown-cover-prompt-title';
    title.className = 'markdown-cover-prompt-title';
    title.textContent = tr('preview.cover.promptTitle', '自定义 cover 提示词');

    const textarea = document.createElement('textarea');
    textarea.name = 'coverPrompt';
    textarea.placeholder = tr('preview.cover.promptPlaceholder', '这张 cover 想往哪个方向调整？');
    textarea.setAttribute('aria-label', tr('preview.cover.promptLabel', 'Cover 提示词'));

    const actions = document.createElement('div');
    actions.className = 'markdown-cover-prompt-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = tr('common.cancel', '取消');

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'markdown-cover-prompt-primary';
    submitButton.textContent = tr('common.generate', '生成');

    actions.append(cancelButton, submitButton);
    form.append(title, textarea, actions);
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    let settled = false;
    const close = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (activeGuidanceDialog?.close === close) activeGuidanceDialog = null;
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
    };

    activeGuidanceDialog = { close };
    cancelButton.addEventListener('click', () => close(null));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close(null);
    });
    form.addEventListener('pointerdown', (event) => event.stopPropagation());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      close(textarea.value);
    });
    window.addEventListener('keydown', onKeyDown, true);
    requestAnimationFrame(() => textarea.focus());
  });
}

export async function saveMarkdownCoverImage(imagePath: string | null | undefined): Promise<void> {
  if (!imagePath || isExternalCoverImagePath(imagePath)) {
    dispatchCoverNotice('当前 cover 不是本地图片，无法直接保存。', 'error');
    return;
  }
  const folder = await window.platform?.selectFolder?.();
  if (!folder || !window.platform?.copyFile) return;
  const ok = await window.platform.copyFile(imagePath, joinLocalPath(folder, localBasename(imagePath)));
  dispatchCoverNotice(ok ? 'Cover 图片已保存。' : 'Cover 图片保存失败。', ok ? 'success' : 'error');
}

export async function regenerateMarkdownCoverWithPrompt(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  const prompt = await requestMarkdownCoverGuidance();
  if (prompt === null) return;
  try {
    const coverStatus = await readCoverGenerationStatus();
    const generationStatus = coverStatus.agentGenerate ?? {};
    const generationEnabled = Boolean(generationStatus.enabled ?? coverStatus.enabled);
    if (!generationEnabled) {
      dispatchCoverNotice(`Cover 生成失败：${getAgentGenerateDisabledText(generationStatus)}`, 'error');
      return;
    }

    const executorAgentId = generationStatus.executorAgentId
      || coverStatus.agentId
      || undefined;
    const result = await requestMarkdownCoverGeneration({
      filePath,
      executorAgentId,
      userGuidance: prompt,
    });
    if (result.ok === false) {
      dispatchCoverNotice(`Cover 生成失败：${result.error}`, 'error');
      return;
    }
    dispatchCoverNotice('已提交新的 cover 生成任务。', 'success');
  } catch (err) {
    dispatchCoverNotice(`Cover 生成失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}
