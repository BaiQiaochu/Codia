/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { shouldAllowInputFocus } from '../../utils/input-focus-policy';

describe('input focus policy', () => {
  it('allows focus when the document body owns focus', () => {
    document.body.innerHTML = '<main></main>';
    document.body.focus();

    expect(shouldAllowInputFocus({ document })).toBe(true);
  });

  it('allows focus when focus is already inside the input surface', () => {
    document.body.innerHTML = '<div id="input"><button id="send">send</button></div>';
    const inputRoot = document.getElementById('input') as HTMLElement;
    const button = document.getElementById('send') as HTMLButtonElement;
    button.focus();

    expect(shouldAllowInputFocus({ document, inputRoot })).toBe(true);
  });

  it('does not steal focus from another text input', () => {
    document.body.innerHTML = '<input id="settings" />';
    const input = document.getElementById('settings') as HTMLInputElement;
    input.focus();

    expect(shouldAllowInputFocus({ document })).toBe(false);
  });

  it('does not steal focus while a modal dialog is open', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"><button>close</button></div>';
    document.body.focus();

    expect(shouldAllowInputFocus({ document })).toBe(false);
  });

  it('does not steal focus while the user has selected text', () => {
    document.body.innerHTML = '<p id="text">select this text</p>';
    const node = document.getElementById('text')?.firstChild;
    if (!node) throw new Error('text node missing');
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 6);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(shouldAllowInputFocus({ document })).toBe(false);
  });
});
