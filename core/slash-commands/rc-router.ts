// @ts-nocheck
import { collectMediaItems } from "../../lib/tools/media-details.ts";
import { formatSettingsUpdateText } from "../../lib/tools/settings-update-result.ts";
import { modelSupportsDirectImageInput } from "../../shared/model-capabilities.ts";

export async function promptAttachedDesktopSession(engine, sessionPath, text, opts = {}) {
  if (!engine || typeof engine.ensureSessionLoaded !== "function") {
    throw new Error("rc-router: engine.ensureSessionLoaded unavailable");
  }

  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session) throw new Error(`rc-router: failed to load session ${sessionPath}`);

  let captured = "";
  const toolMedia = [];
  const unsub = session.subscribe((event) => {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const delta = sub.delta || "";
        captured += delta;
        try {
          opts.onDelta?.(delta, captured);
        } catch {}
      }
    } else if (event.type === "tool_execution_end" && !event.isError) {
      toolMedia.push(...collectMediaItems(event.result?.details?.media));
      const card = event.result?.details?.card;
      if (card?.description) {
        captured += (captured ? "\n\n" : "") + card.description;
      }
      const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
      if (settingsUpdateText) {
        captured += (captured ? "\n\n" : "") + settingsUpdateText;
      }
    }
  });

  try {
    const inputMods = session.model?.input;
    let promptOpts;
    if (opts.images?.length && Array.isArray(inputMods) && !modelSupportsDirectImageInput(session.model)) {
      promptOpts = undefined;
    } else if (opts.images?.length) {
      promptOpts = { images: opts.images };
    }
    await session.prompt(text, promptOpts);
  } finally {
    unsub?.();
  }

  return {
    text: captured.trim() || null,
    toolMedia,
  };
}
