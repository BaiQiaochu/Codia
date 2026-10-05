import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function rule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

describe('long reply layout wiring', () => {
  it('keeps chat session scrolling constrained inside the session shell', () => {
    const source = read('components/chat/Chat.module.css');

    expect(source).toMatch(/\.sessionShell\s*\{[\s\S]*--chat-scrollbar-bottom-inset:\s*var\(--input-card-bottom-inset,\s*calc\(var\(--input-card-h,\s*0px\) \/ 2\)\);[\s\S]*bottom:\s*calc\(var\(--chat-scrollbar-bottom-inset\) \+ var\(--space-lg\)\);[\s\S]*overflow:\s*hidden;/);
    expect(source).toMatch(/\.sessionPanel\s*\{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*0;[\s\S]*overflow-y:\s*auto;/);
    expect(source).toMatch(/\.sessionFooter\s*\{[\s\S]*height:\s*calc\(var\(--chat-scrollbar-bottom-inset\) \+ var\(--space-lg\) \+ 5rem\);/);
    expect(source).not.toMatch(/\.sessionPanel\s*\{[\s\S]*bottom:\s*auto;[\s\S]*\}/);
    expect(source).not.toMatch(/:global\(body\.obsidian-mode\) \.sessionPanel\s*\{[\s\S]*bottom:\s*auto;[\s\S]*\}/);
  });

  it('measures the input card and bottom inset so chat scrolling does not overlap the composer', () => {
    const appSource = read('App.tsx');
    const globalCss = read('../../src/styles.css');

    expect(appSource).toContain('const inputAreaRef = useRef<HTMLDivElement>(null);');
    expect(appSource).toContain('const inputCardRef = useRef<HTMLDivElement>(null);');
    expect(appSource).toContain("const el = inputAreaRef.current;");
    expect(appSource).toContain('calculateInputCardBottomInset');
    expect(appSource).toContain("parent.style.setProperty('--input-card-bottom-inset'");
    expect(appSource).toContain('window.requestAnimationFrame(() => updateInputHeight())');
    expect(appSource).toContain('ref={inputAreaRef}');
    expect(appSource).toContain('cardRef={inputCardRef}');
    expect(globalCss).toMatch(/\.main-content\s*\{[\s\S]*--input-card-h:\s*8\.5rem;/);
  });

  it('keeps markdown content breakable in the global renderer styles', () => {
    const source = read('../../src/styles.css');

    expect(source).toContain('.md-content {');
    expect(source).toContain('overflow-wrap: anywhere;');
    expect(source).toContain('word-break: break-word;');
    expect(source).toContain('.md-content table {');
    expect(source).toContain('overflow-x: auto;');
  });

  it('keeps chat message bubbles breakable for long assistant and user replies', () => {
    const source = read('components/chat/Chat.module.css');

    expect(source).toMatch(/\.messageUser\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(source).toMatch(/\.messageAssistant\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
  });

  it('keeps expanded thinking blocks readable near the composer edge', () => {
    const source = read('components/chat/Chat.module.css');
    const thinkingBlock = rule(source, '.thinkingBlock');
    const thinkingBody = rule(source, '.thinkingBlockBody');

    expect(thinkingBlock).toContain('scroll-margin-bottom: calc(var(--chat-scrollbar-bottom-inset, calc(var(--input-card-h, 0px) / 2)) + var(--space-lg));');
    expect(thinkingBody).toContain('box-sizing: border-box;');
    expect(thinkingBody).toContain('max-width: 100%;');
    expect(thinkingBody).toContain('overflow-wrap: anywhere;');
    expect(thinkingBody).toContain('word-break: break-word;');
    expect(thinkingBody).not.toContain('overflow: hidden;');
  });

  it('keeps channel message bubbles breakable for long replies', () => {
    const source = read('components/channels/Channels.module.css');

    expect(source).toMatch(/\.channelMsgText\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(source).toMatch(/\.channelMsgText\s*\{[\s\S]*max-width:\s*100%;/);
    expect(source).toContain('.channelMsgText :global(.md-content) {');
    expect(source).toContain('.channelMsgText :global(.md-content pre),');
  });
});
