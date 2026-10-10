const I18N_KEY_PATTERN = /\b(?:input|settings|common|chat|sidebar|welcome|error|status|action|preview|toolDef|plugin|rightWorkspace|quickChat|computerUse)(?:\.[A-Za-z][A-Za-z0-9_-]*)+\b/g;
const IGNORED_TEXT_CONTAINERS = new Set([
  'CODE',
  'INPUT',
  'KBD',
  'PRE',
  'SAMP',
  'SCRIPT',
  'STYLE',
  'TEXTAREA',
]);

type WarnFn = (message: string, details: { leaks: string[] }) => void;

interface AuditOptions {
  root?: ParentNode | null;
  warn?: WarnFn;
}

interface InstallOptions extends AuditOptions {
  enabled?: boolean;
}

export function findVisibleI18nKeyLeaks(root: ParentNode | null = document.body): string[] {
  if (!root || typeof document === 'undefined') return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isIgnoredContainer(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const leaks = new Set<string>();
  let current = walker.nextNode();
  while (current) {
    const text = current.textContent || '';
    for (const match of text.matchAll(I18N_KEY_PATTERN)) {
      leaks.add(match[0]);
    }
    current = walker.nextNode();
  }
  return [...leaks].sort();
}

export function auditI18nKeyLeaks({
  root = typeof document !== 'undefined' ? document.body : null,
  warn = console.warn,
}: AuditOptions = {}): string[] {
  const leaks = findVisibleI18nKeyLeaks(root);
  if (leaks.length) {
    warn(`[i18n] raw locale key leak detected: ${leaks.join(', ')}`, { leaks });
  }
  return leaks;
}

export function installI18nKeyLeakAudit({
  root = typeof document !== 'undefined' ? document.body : null,
  warn = console.warn,
  enabled = shouldEnableI18nKeyLeakAudit(),
}: InstallOptions = {}): () => void {
  if (!enabled || !root || typeof MutationObserver === 'undefined') return () => {};

  let scheduled = false;
  const run = () => {
    scheduled = false;
    auditI18nKeyLeaks({ root, warn });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  };

  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  schedule();

  return () => observer.disconnect();
}

export function shouldEnableI18nKeyLeakAudit(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as Window & { __CODIA_I18N_LEAK_AUDIT__?: boolean };
  if (win.__CODIA_I18N_LEAK_AUDIT__ === true) return true;
  try {
    if (window.localStorage?.getItem('codia:i18n-leak-audit') === '1') return true;
  } catch {
    // Ignore localStorage access failures in restricted renderer contexts.
  }
  return getImportMetaDev() === true;
}

function getImportMetaDev(): boolean {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

function isIgnoredContainer(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (IGNORED_TEXT_CONTAINERS.has(current.tagName)) return true;
    if (current.getAttribute('aria-hidden') === 'true') return true;
    current = current.parentElement;
  }
  return false;
}
