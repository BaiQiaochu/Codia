import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAppFileDragPayload,
  getActiveAppFileDragPayload,
  readAppFileDragPayload,
  writeAppFileDragPayload,
} from '../../utils/app-file-drag';

function dataTransferStub() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) || '',
  } as unknown as DataTransfer;
}

describe('app-file-drag', () => {
  afterEach(() => {
    clearAppFileDragPayload();
  });

  it('writes a keyed internal drag payload and reads it back from dataTransfer', () => {
    const dataTransfer = dataTransferStub();

    const payload = writeAppFileDragPayload(dataTransfer, {
      source: 'session-file',
      files: [{
        id: 'sf_report',
        fileId: 'sf_report',
        name: 'report.pdf',
        path: '/tmp/session-files/report.pdf',
        isDirectory: false,
      }],
    });

    expect(payload.dragId).toMatch(/^codia-drag-/);
    expect(readAppFileDragPayload(dataTransfer)).toEqual(payload);
    expect(getActiveAppFileDragPayload()).toEqual(payload);

    clearAppFileDragPayload(payload.dragId);
    expect(readAppFileDragPayload(dataTransfer)).toBeNull();
  });

  it('does not treat an external file drop as the active internal drag payload', () => {
    const internalTransfer = dataTransferStub();
    const payload = writeAppFileDragPayload(internalTransfer, {
      source: 'session-file',
      files: [{
        id: 'sf_internal',
        fileId: 'sf_internal',
        name: 'internal.txt',
        path: '/tmp/session-files/internal.txt',
        isDirectory: false,
      }],
    });

    const externalFileDrop = dataTransferStub();

    expect(readAppFileDragPayload(externalFileDrop)).toBeNull();
    expect(getActiveAppFileDragPayload()).toEqual(payload);
  });
});
