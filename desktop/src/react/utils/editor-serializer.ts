import type { JSONContent } from '@tiptap/core';
import type { AttachedFile } from '../stores/input-slice';
import { isQuickActionId, type ComposerReferences } from '../../../../shared/quick-actions';

export interface EditorFileRef {
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  mimeType?: string;
  base64Data?: AttachedFile['base64Data'];
  presentation?: AttachedFile['presentation'];
  listed?: AttachedFile['listed'];
  waveform?: AttachedFile['waveform'];
  transcription?: AttachedFile['transcription'];
  resource?: AttachedFile['resource'];
}

/**
 * Walk TipTap JSON document, extract input badges and plain text.
 */
export function serializeEditor(json: JSONContent): { text: string; skills: string[]; fileRefs: EditorFileRef[] } & ComposerReferences {
  const references: ComposerReferences = { agentMentions: [], sessionRefs: [] };
  const skills: string[] = [];
  const fileRefs: EditorFileRef[] = [];
  const textParts: string[] = [];

  function walk(node: JSONContent) {
    if (node.type === 'quickActionBadge' && isQuickActionId(node.attrs?.actionId)) {
      references.quickAction = node.attrs.actionId;
      return;
    }
    if (node.type === 'agentBadge' && node.attrs?.agentId) {
      if (!references.agentMentions.some(ref => ref.agentId === node.attrs!.agentId)) {
        references.agentMentions.push({ agentId: node.attrs.agentId, label: node.attrs.label || node.attrs.agentId });
      }
      return;
    }
    if (node.type === 'sessionBadge' && node.attrs?.sessionId) {
      const label = String(node.attrs.label || node.attrs.sessionId);
      if (!references.sessionRefs.some(ref => ref.sessionId === node.attrs!.sessionId)) references.sessionRefs.push({ sessionId: node.attrs.sessionId, label });
      return;
    }
    if (node.type === 'skillBadge' && node.attrs?.name) {
      skills.push(node.attrs.name as string);
      return;
    }
    if (node.type === 'pluginBadge' && node.attrs?.id) {
      textParts.push(`$${String(node.attrs.id)}`);
      return;
    }
    if (node.type === 'fileBadge' && node.attrs) {
      const name = typeof node.attrs.name === 'string' ? node.attrs.name : '';
      const path = typeof node.attrs.path === 'string' ? node.attrs.path : '';
      if (name || path) {
        const label = name || path.split('/').pop() || path;
        textParts.push(`@${label}`);
        fileRefs.push({
          ...(typeof node.attrs.fileId === 'string' && node.attrs.fileId ? { fileId: node.attrs.fileId } : {}),
          path,
          name: label,
          isDirectory: node.attrs.isDirectory === true,
          ...(typeof node.attrs.mimeType === 'string' && node.attrs.mimeType ? { mimeType: node.attrs.mimeType } : {}),
        });
      }
      return;
    }
    if (node.type === 'text' && node.text) {
      textParts.push(node.text);
      return;
    }
    if (node.type === 'hardBreak') {
      textParts.push('\n');
      return;
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
    if (node.type === 'paragraph' && textParts.length > 0) {
      textParts.push('\n');
    }
  }

  walk(json);

  const text = textParts.join('').replace(/\n+$/, '').trim();

  return { text, skills, fileRefs, ...references };
}
