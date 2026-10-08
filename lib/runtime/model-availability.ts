// @ts-nocheck
import { findModel } from "../../shared/model-ref.ts";

export function resolveRunnableModel({ availableModels = [], agentConfig = {}, explicitModel = null }) {
  if (!Array.isArray(availableModels) || availableModels.length === 0) return null;

  const explicitId = typeof explicitModel === "object" ? explicitModel?.id : explicitModel;
  const explicitProvider = typeof explicitModel === "object" ? explicitModel?.provider : undefined;
  if (explicitId) {
    return findModel(availableModels, explicitId, explicitProvider) || null;
  }

  const chatRef = agentConfig?.models?.chat;
  const chatId = typeof chatRef === "object" ? chatRef?.id : chatRef;
  const chatProvider = typeof chatRef === "object" ? chatRef?.provider : undefined;
  if (!chatId) return null;

  return findModel(availableModels, chatId, chatProvider) || null;
}

export function canRunBackgroundTask(args) {
  return !!resolveRunnableModel(args);
}
