import {
  getModelThinkingLevels,
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
} from "../core/session-thinking-level.ts";

function targetModelForSession(engine: any, sessionPath?: string | null) {
  if (!sessionPath) return engine?.currentModel || null;
  try {
    return engine?.getSessionByPath?.(sessionPath)?.model || engine?.currentModel || null;
  } catch {
    return engine?.currentModel || null;
  }
}

function pendingDefaultThinkingLevel(engine: any, model: any) {
  if (typeof engine?.getDefaultThinkingLevel === "function") {
    return engine.getDefaultThinkingLevel(model);
  }
  if (typeof engine?.getThinkingLevel === "function") {
    return engine.getThinkingLevel();
  }
  return "medium";
}

export function resolveSessionThinkingLevelState(engine: any, {
  pendingNewSession = false,
  sessionPath = null,
}: {
  pendingNewSession?: boolean;
  sessionPath?: string | null;
} = {}) {
  const targetModel = targetModelForSession(engine, sessionPath);
  const requested = pendingNewSession
    ? pendingDefaultThinkingLevel(engine, targetModel)
    : (
        sessionPath && typeof engine?.getSessionThinkingLevel === "function"
          ? engine.getSessionThinkingLevel(sessionPath)
          : pendingDefaultThinkingLevel(engine, targetModel)
      );

  return {
    thinkingLevel: normalizeThinkingLevelForModel(normalizeSessionThinkingLevel(requested), targetModel),
    thinkingLevels: targetModel ? getModelThinkingLevels(targetModel) : null,
  };
}
