import type { ContentBlock } from '../stores/chat-types';

function textFromHtml(html: string): string {
  if (!html) return '';
  if (typeof document !== 'undefined') {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.innerText ?? tmp.textContent ?? '').trim();
  }
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractTextBlockPlainText(blocks: readonly ContentBlock[]): string {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const source = typeof block.source === 'string' ? block.source.trim() : '';
    if (source) {
      texts.push(source);
      continue;
    }
    if (block.html) texts.push(textFromHtml(block.html));
  }
  return texts.filter(Boolean).join('\n');
}
