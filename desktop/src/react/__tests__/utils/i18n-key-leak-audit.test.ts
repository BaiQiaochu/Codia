// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditI18nKeyLeaks,
  findVisibleI18nKeyLeaks,
} from '../../utils/i18n-key-leak-audit';

describe('i18n key leak audit', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('detects visible dotted i18n keys rendered into the DOM', () => {
    document.body.innerHTML = `
      <main>
        <button>input.autoMode</button>
        <section>settings.tabs.diagnostics</section>
      </main>
    `;

    expect(findVisibleI18nKeyLeaks(document.body)).toEqual([
      'input.autoMode',
      'settings.tabs.diagnostics',
    ]);
  });

  it('ignores code and form text where keys are examples or values', () => {
    document.body.innerHTML = `
      <main>
        <code>input.autoMode</code>
        <pre>settings.tabs.diagnostics</pre>
        <textarea>common.cancel</textarea>
      </main>
    `;

    expect(findVisibleI18nKeyLeaks(document.body)).toEqual([]);
  });

  it('warns with the leaked keys for runtime diagnostics', () => {
    document.body.innerHTML = '<button>input.autoMode</button>';
    const warn = vi.fn();

    const leaks = auditI18nKeyLeaks({ root: document.body, warn });

    expect(leaks).toEqual(['input.autoMode']);
    expect(warn).toHaveBeenCalledWith(
      '[i18n] raw locale key leak detected: input.autoMode',
      { leaks: ['input.autoMode'] },
    );
  });
});
