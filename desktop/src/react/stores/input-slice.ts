import { sessionScopedKey } from './session-slice';
import type { JSONContent } from '@tiptap/core';
import type { WorkspaceToolSelection } from '../utils/workspace-tool-events';
import { normalizeWorkspaceToolSelection } from '../utils/workspace-tool-events';

export interface AttachedFile {
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
  presentation?: 'attachment' | 'voice-input' | string;
  listed?: boolean;
  waveform?: import('./chat-types').AudioWaveform;
  transcription?: import('./chat-types').VoiceTranscription;
  resource?: import('./chat-types').ResourceEnvelope;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface FloatingAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface QuotedSelection {
  text: string;
  sourceTitle: string;
  sourceKind: 'preview' | 'chat';
  sourceFilePath?: string;
  sourceSessionPath?: string;
  sourceMessageId?: string;
  sourceRole?: 'user' | 'assistant';
  selectionAnchorKind?: 'native' | 'codemirror';
  lineStart?: number;
  lineEnd?: number;
  charCount: number;
  anchorRect?: FloatingAnchorRect;
  updatedAt?: number;
}

export interface InputSlice {
  attachedFiles: AttachedFile[];
  /** 按 session path 存储的附件（权威源） */
  attachedFilesBySession: Record<string, AttachedFile[]>;
  /** 按 session path 存储的草稿文本（内存级，关窗口清空） */
  drafts: Record<string, string>;
  /** Rich drafts keep skill and file badges intact when switching sessions. */
  editorDrafts: Record<string, JSONContent>;
  deskContextAttached: boolean;
  docContextAttached: boolean;
  inputFocusTrigger: number;
  quoteCandidate: QuotedSelection | null;
  quotedSelections: QuotedSelection[];
  /** @deprecated Use quotedSelections for committed quotes and quoteCandidate for transient selection UI. */
  quotedSelection: QuotedSelection | null;
  workspaceTool: WorkspaceToolSelection | null;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  setDraft: (sessionPath: string, text: string, document?: JSONContent) => void;
  clearDraft: (sessionPath: string) => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean) => void;
  toggleDocContext: () => void;
  requestInputFocus: () => void;
  setQuoteCandidate: (sel: QuotedSelection) => void;
  clearQuoteCandidate: () => void;
  addQuotedSelection: (sel: QuotedSelection) => void;
  removeQuotedSelection: (index: number) => void;
  clearQuotedSelections: () => void;
  setQuotedSelections: (sels: QuotedSelection[]) => void;
  /** @deprecated Use addQuotedSelection or setQuoteCandidate. */
  setQuotedSelection: (sel: QuotedSelection) => void;
  /** @deprecated Use clearQuotedSelections and clearQuoteCandidate. */
  clearQuotedSelection: () => void;
  setWorkspaceTool: (tool: WorkspaceToolSelection | null) => void;
  clearWorkspaceTool: () => void;
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void
): InputSlice => ({
  attachedFiles: [],
  attachedFilesBySession: {},
  drafts: {},
  editorDrafts: {},
  deskContextAttached: false,
  docContextAttached: false,
  inputFocusTrigger: 0,
  quoteCandidate: null,
  quotedSelections: [],
  quotedSelection: null,
  workspaceTool: null,
  addAttachedFile: (file) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [...asAttachedFiles(s.attachedFiles), file])),
  removeAttachedFile: (index) =>
    set((s) => syncCurrentSessionAttachments(
      s as InputSlice & { currentSessionPath?: string | null },
      asAttachedFiles(s.attachedFiles).filter((_, i) => i !== index),
    )),
  setAttachedFiles: (files) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, asAttachedFiles(files))),
  clearAttachedFiles: () =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [])),
  setDraft: (sessionPath, text, document) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const drafts = { ...s.drafts, [key]: text };
      const editorDrafts = { ...s.editorDrafts };
      if (document) editorDrafts[key] = document;
      else delete editorDrafts[key];
      if (key !== sessionPath) delete drafts[sessionPath];
      if (key !== sessionPath) delete editorDrafts[sessionPath];
      return { drafts, editorDrafts };
    }),
  clearDraft: (sessionPath) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const drafts = { ...s.drafts };
      const editorDrafts = { ...s.editorDrafts };
      delete drafts[key];
      delete drafts[sessionPath];
      delete editorDrafts[key];
      delete editorDrafts[sessionPath];
      return { drafts, editorDrafts };
    }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: (attached) => set({ docContextAttached: attached }),
  toggleDocContext: () =>
    set((s) => ({ docContextAttached: !s.docContextAttached })),
  requestInputFocus: () =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1 })),
  setQuoteCandidate: (sel) => set({ quoteCandidate: sel }),
  clearQuoteCandidate: () => set({ quoteCandidate: null }),
  addQuotedSelection: (sel) =>
    set((s) => {
      const quotedSelections = [...asQuotedSelections(s.quotedSelections), sel];
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  removeQuotedSelection: (index) =>
    set((s) => {
      const quotedSelections = asQuotedSelections(s.quotedSelections).filter((_, i) => i !== index);
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  clearQuotedSelections: () => set({ quotedSelections: [], quotedSelection: null }),
  setQuotedSelections: (sels) => set({ quotedSelections: sels, quotedSelection: sels[0] ?? null }),
  setQuotedSelection: (sel) => set({ quotedSelections: [sel], quotedSelection: sel }),
  clearQuotedSelection: () => set({ quoteCandidate: null, quotedSelections: [], quotedSelection: null }),
  setWorkspaceTool: (tool) => set({ workspaceTool: normalizeWorkspaceToolSelection(tool) }),
  clearWorkspaceTool: () => set({ workspaceTool: null }),
});

function asAttachedFiles(value: unknown): AttachedFile[] {
  return Array.isArray(value) ? value as AttachedFile[] : [];
}

function asQuotedSelections(value: unknown): QuotedSelection[] {
  return Array.isArray(value) ? value as QuotedSelection[] : [];
}


function syncCurrentSessionAttachments(state: InputSlice & { currentSessionPath?: string | null }, files: AttachedFile[]) {
  const patch: Partial<InputSlice> = {
    attachedFiles: files,
  };
  const currentSessionPath = state.currentSessionPath;
  if (currentSessionPath) {
    const key = sessionScopedKey(state as any, currentSessionPath) || currentSessionPath;
    patch.attachedFilesBySession = {
      ...(state.attachedFilesBySession && typeof state.attachedFilesBySession === 'object' ? state.attachedFilesBySession : {}),
      [key]: files,
    };
    if (key !== currentSessionPath) delete patch.attachedFilesBySession[currentSessionPath];
  }
  return patch;
}
