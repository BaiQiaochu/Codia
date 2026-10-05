import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { injectCopyButtons } from '../../utils/format';
import { bindMarkdownImagePreview } from '../../utils/markdown-image-preview';
import { bindMarkdownVisualControls } from '../../utils/markdown-visual-controls';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { splitGraphemes } from '../../utils/grapheme';
import { openInternalLink, type LinkOpenContext } from '../../utils/link-open';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';
import styles from './Chat.module.css';

interface Props {
  html: string;
  className?: string;
  tailFadeCount?: number;
  linkContext?: LinkOpenContext;
}

function handleMarkdownLinkClick(event: globalThis.MouseEvent, context?: LinkOpenContext): void {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest<HTMLAnchorElement>('a[href]');
  if (!anchor) return;

  const rawHref = anchor.getAttribute('href') || '';
  if (!rawHref || rawHref.startsWith('#')) return;

  event.preventDefault();
  event.stopPropagation();
  void openInternalLink(rawHref, {
    ...(context || {}),
    label: anchor.textContent || context?.label,
  });
}

function shouldSkipTailFadeNode(node: Text): boolean {
  const parent = node.parentElement;
  return !parent || !!parent.closest('pre, code, table, .katex, .mermaid, svg, button');
}

function clearTailFade(root: HTMLElement): void {
  const tailSpans = Array.from(root.querySelectorAll<HTMLElement>('[data-stream-tail-char="true"]'));
  for (const span of tailSpans) {
    span.replaceWith(document.createTextNode(span.textContent || ''));
  }
  if (tailSpans.length > 0) root.normalize();
}

function applyTailFade(root: HTMLElement, count: number): void {
  clearTailFade(root);
  if (count <= 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (text.nodeValue && text.nodeValue.trim() && !shouldSkipTailFadeNode(text)) {
      textNodes.push(text);
    }
    current = walker.nextNode();
  }

  const tailNodes: Array<{ node: Text; segments: string[]; take: number }> = [];
  let remaining = count;
  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const node = textNodes[i];
    const segments = splitGraphemes(node.nodeValue || '');
    if (segments.length === 0) continue;
    const take = Math.min(remaining, segments.length);
    tailNodes.push({ node, segments, take });
    remaining -= take;
  }

  let index = 0;
  for (const item of tailNodes.reverse()) {
    const splitAt = item.segments.length - item.take;
    const before = item.segments.slice(0, splitAt).join('');
    const tail = item.segments.slice(splitAt);
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    for (const segment of tail) {
      // eslint-disable-next-line no-restricted-syntax -- markdown stream tail decoration needs post-render text-node surgery
      const span = document.createElement('span');
      span.className = styles.streamTailChar;
      span.dataset.streamTailChar = 'true';
      span.style.setProperty('--stream-tail-index', String(index));
      span.textContent = segment;
      fragment.appendChild(span);
      index += 1;
    }
    item.node.parentNode?.replaceChild(fragment, item.node);
  }
}

export const MarkdownContent = memo(function MarkdownContent({ html, className, tailFadeCount = 0, linkContext }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
  const classes = className ? `md-content ${className}` : 'md-content';

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const root = ref.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !root.contains(anchor)) return;

    event.preventDefault();
    event.stopPropagation();
    setLinkMenu({
      href: anchor.getAttribute('href') || '',
      context: {
        ...(linkContext || {}),
        label: anchor.textContent?.trim() || linkContext?.label,
      },
      position: { x: event.clientX, y: event.clientY },
    });
  }, [linkContext]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    applyTailFade(ref.current, tailFadeCount);
  }, [html, tailFadeCount]);

  useEffect(() => {
    if (!ref.current) return;
    const root = ref.current;
    const onClick = (event: globalThis.MouseEvent) => handleMarkdownLinkClick(event, linkContext);
    root.addEventListener('click', onClick);
    injectCopyButtons(root);
    const unbindImages = bindMarkdownImagePreview(root);
    const unbindVisualControls = bindMarkdownVisualControls(root);
    return () => {
      root.removeEventListener('click', onClick);
      unbindVisualControls();
      unbindImages();
    };
  }, [html, linkContext]);
  useMermaidDiagrams(ref, [html]);

  return (
    <>
      <div
        ref={ref}
        className={classes}
        onContextMenu={handleContextMenu}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
});
