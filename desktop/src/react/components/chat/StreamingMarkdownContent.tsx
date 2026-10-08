import { memo } from 'react';
import { useAdaptiveStreamText } from '../../hooks/use-adaptive-stream-text';
import type { LinkOpenContext } from '../../utils/link-open';
import { MarkdownContent } from './MarkdownContent';
import styles from './Chat.module.css';

interface Props {
  html: string;
  source?: string;
  active?: boolean;
  className?: string;
  linkContext?: LinkOpenContext;
}

const COMPLEX_MARKDOWN_PATTERNS = [
  /(^|\n)\s*(```|~~~)/,
  /(^|\n)\s*\$\$/,
  /(^|\n)\s*\\\[/,
  /(^|\n)\s*\|.*\|/,
  /(^|\n)\s{4,}\S/,
  /(^|\n)\s*<[^>\n]+>/,
];
const BACKTICK_SENSITIVE_MARKDOWN = /`/;

function cx(...parts: Array<string | false | null | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value || undefined;
}

function splitPlainTextParagraphs(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter(paragraph => paragraph.length > 0);
  return paragraphs.length > 0 ? paragraphs : [''];
}

export function isTypewriterEligibleMarkdownSource(source: string): boolean {
  if (!source.trim()) return false;
  if (BACKTICK_SENSITIVE_MARKDOWN.test(source)) return false;
  return !COMPLEX_MARKDOWN_PATTERNS.some((pattern) => pattern.test(source));
}

export const StreamingMarkdownContent = memo(function StreamingMarkdownContent({
  html,
  source,
  active = false,
  className,
  linkContext,
}: Props) {
  const shouldAnimateStream = !!source && active;
  const shouldUsePlainTextStream = shouldAnimateStream && isTypewriterEligibleMarkdownSource(source);
  const shouldAnimateBlock = shouldAnimateStream && !shouldUsePlainTextStream;
  const visiblePlainText = useAdaptiveStreamText(source || '', {
    active: shouldUsePlainTextStream,
    displayFps: 30,
  });

  if (shouldUsePlainTextStream) {
    return (
      <div
        className={cx('md-content', styles.streamPlainText, className)}
        data-stream-plain-text="true"
      >
        {splitPlainTextParagraphs(visiblePlainText).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    );
  }

  return (
    <MarkdownContent
      html={html}
      className={cx(className, shouldAnimateBlock && styles.streamMarkdownBlockEnter)}
      linkContext={linkContext}
    />
  );
});
