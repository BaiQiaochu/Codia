// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  INPUT_DRAFT_REQUEST_EVENT,
  readInputDraftRequestDetail,
  requestInputDraft,
} from '../../utils/input-draft-events';

describe('input draft events', () => {
  it('normalizes draft requests before they reach InputArea', () => {
    const event = new CustomEvent(INPUT_DRAFT_REQUEST_EVENT, {
      detail: { text: '  research task  ', mode: 'append', source: 'home-research' },
    });

    expect(readInputDraftRequestDetail(event)).toEqual({
      text: 'research task',
      mode: 'append',
      focus: true,
      source: 'home-research',
    });
  });

  it('dispatches a replace draft request by default', () => {
    let captured: Event | null = null;
    const listener = (event: Event) => { captured = event; };
    window.addEventListener(INPUT_DRAFT_REQUEST_EVENT, listener);

    requestInputDraft('draft from action');

    window.removeEventListener(INPUT_DRAFT_REQUEST_EVENT, listener);
    expect(captured).toBeTruthy();
    expect(readInputDraftRequestDetail(captured as Event)).toMatchObject({
      text: 'draft from action',
      mode: 'replace',
      focus: true,
    });
  });

  it('rejects empty or malformed draft events', () => {
    expect(readInputDraftRequestDetail(new CustomEvent(INPUT_DRAFT_REQUEST_EVENT, { detail: { text: '   ' } }))).toBeNull();
    expect(readInputDraftRequestDetail(new CustomEvent(INPUT_DRAFT_REQUEST_EVENT, { detail: null }))).toBeNull();
    expect(readInputDraftRequestDetail(new Event('other'))).toBeNull();
  });
});
