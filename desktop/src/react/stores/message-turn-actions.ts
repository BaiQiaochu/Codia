import { useStore } from './index';
import type { ChatMessage } from './chat-types';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { collectUiContext } from '../utils/ui-context';
import { toStringArray } from './session-selectors';

export async function replayLatestUserMessage(
  sessionPath: string,
  message: ChatMessage,
  replacementText?: string,
): Promise<boolean> {
  if (!sessionPath || !message?.id) return false;

  try {
    const state = useStore.getState();
    if (toStringArray(state.streamingSessions).includes(sessionPath)) return false;

    await codiaFetch('/api/sessions/latest-user-message/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: sessionPath,
        sourceEntryId: message.sourceEntryId || null,
        clientMessageId: message.id,
        text: replacementText,
        uiContext: collectUiContext(state, { workspaceTool: message.workspaceTool || null }),
        displayMessage: {
          text: replacementText ?? message.text ?? '',
          quickAction: message.quickAction,
          sessionRefs: message.sessionRefs,
          quotedText: message.quotedText,
          attachments: message.attachments,
          skills: message.skills,
          plugins: message.plugins,
          workspaceTool: message.workspaceTool,
          deskContext: message.deskContext ?? null,
        },
      }),
    });
    return true;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    useStore.getState().setInlineError?.(sessionPath, text, 6000);
    return false;
  }
}
