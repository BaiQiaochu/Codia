import { extractToolDetail } from './message-parser';
import { extractTextBlockPlainText } from './message-text';
import type { ChatMessage, ContentBlock, ToolCall, UserAttachment } from '../stores/chat-types';

function htmlToText(html: string): string {
  if (!html) return '';
  if (typeof document !== 'undefined') {

    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.innerText.trim();
  }
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function fileNameFromPath(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() || filePath;
}

function serializeToolCall(tool: ToolCall): string {
  const detail = extractToolDetail(tool.name, tool.args);
  const status = tool.done ? (tool.success ? 'done' : 'failed') : 'running';
  const parts = [tool.name];

  if (detail.text) parts.push(detail.text);
  if (typeof tool.args?.agentId === 'string' && tool.args.agentId) parts.push(tool.args.agentId);
  parts.push(status);

  return parts.join(' ').trim();
}

function serializeAttachment(att: UserAttachment): string {
  return att.name || fileNameFromPath(att.path);
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'thinking':
      return block.content?.trim() || '';
    case 'mood':
      return block.text?.trim() || '';
    case 'invoke':
      return [`<invoke name="${block.name}">`, block.content?.trim() || '', '</invoke>'].join('\n').trim();
    case 'tool_group':
      return block.tools.map(serializeToolCall).filter(Boolean).join('\n');
    case 'text':
      return extractTextBlockPlainText([block]);
    case 'file':
      return block.label || fileNameFromPath(block.filePath);
    case 'artifact':
      return block.title || block.artifactType;
    case 'screenshot':
      return window.t?.('chat.browserScreenshot') || 'Browser screenshot';
    case 'skill':
      return block.skillName;
    case 'cron_confirm': {
      const label = String(block.jobData?.label || block.jobData?.prompt || '').trim();
      return label || 'Cron task';
    }
    case 'suggestion_card':
      return [block.title, block.description].filter(Boolean).join('\n');
    case 'settings_confirm':
      return [block.label, block.currentValue, block.proposedValue].filter(Boolean).join(' ');
    case 'subagent':
      return [block.taskTitle || block.task, block.summary || ''].filter(Boolean).join('\n');
    case 'plugin_card':
      return [block.card.title || '', block.card.description || ''].filter(Boolean).join('\n');
    default:
      return '';
  }
}

export function serializeChatMessageForCopy(message: ChatMessage): string {
  if (message.role === 'user') {
    const parts: string[] = [];
    if (message.quotedText) parts.push(message.quotedText.trim());
    if (Array.isArray(message.skills) && message.skills.length > 0) {
      parts.push(message.skills.join(' '));
    }
    if (Array.isArray(message.plugins) && message.plugins.length > 0) {
      parts.push(message.plugins.map(plugin => `$${plugin.id}`).join(' '));
    }
    if (message.textHtml) {
      parts.push(htmlToText(message.textHtml));
    } else if (message.text) {
      parts.push(message.text.trim());
    }
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      parts.push(message.attachments.map(serializeAttachment).join('\n'));
    }
    if (message.deskContext) {
      parts.push(`${window.t?.('sidebar.jian') || 'Jian'} (${message.deskContext.fileCount})`);
    }
    return parts.filter(Boolean).join('\n').trim();
  }

  return (message.blocks || [])
    .map(serializeBlock)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
