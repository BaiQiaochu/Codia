import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import { closeTabForOwner, openTabForOwner, updatePreviewReadingPositionForOwner } from '../../stores/preview-actions';
import { DESK_OWNER, selectPreviewReadingPositions } from '../../stores/preview-slice';

describe('preview reading positions', () => {
  beforeEach(() => {
    useStore.setState({
      currentSessionPath: null,
      previewByOwner: {},
    } as never);
  });

  it('removes a closed tab reading position from the owner preview state', () => {
    openTabForOwner(DESK_OWNER, 'file-a');
    updatePreviewReadingPositionForOwner(DESK_OWNER, 'file-a', 'preview', {
      scrollTop: 120,
      ratio: 0.5,
      contentHash: 'hash-a',
    }, { id: 'intro', text: 'Intro' });

    expect(selectPreviewReadingPositions(useStore.getState())).toMatchObject({
      'file-a': {
        preview: {
          scrollTop: 120,
          ratio: 0.5,
          contentHash: 'hash-a',
        },
        currentHeadingId: 'intro',
        currentHeadingText: 'Intro',
      },
    });

    closeTabForOwner(DESK_OWNER, 'file-a');

    expect(selectPreviewReadingPositions(useStore.getState())).toEqual({});
  });
});
