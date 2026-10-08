function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

const VALID_TYPES = new Set(["at", "every", "cron"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function applyConfirmedAutomationDraft(baseJobData: unknown, confirmationValue: unknown) {
  const base = asRecord(baseJobData);
  const value = asRecord(confirmationValue);
  const draft = asRecord(value?.jobData);
  if (!base || !draft) return baseJobData;

  const next = clonePlain(base);

  if (typeof draft.type === "string" && VALID_TYPES.has(draft.type)) next.type = draft.type;
  if (draft.schedule !== undefined) next.schedule = draft.schedule;
  if (typeof draft.prompt === "string") next.prompt = draft.prompt;
  if (typeof draft.label === "string") next.label = draft.label;
  if (typeof draft.actorAgentId === "string" && draft.actorAgentId.trim()) {
    next.actorAgentId = draft.actorAgentId.trim();
  }
  if (draft.executionContext && typeof draft.executionContext === "object" && !Array.isArray(draft.executionContext)) {
    next.executionContext = clonePlain(draft.executionContext);
  }
  if (Object.prototype.hasOwnProperty.call(draft, "model")) {
    next.model = clonePlain(draft.model);
  }

  const executor = asRecord(next.executor);
  if (executor?.kind === "agent_session") {
    next.executor = {
      ...executor,
      prompt: typeof next.prompt === "string" ? next.prompt : "",
      model: clonePlain(next.model ?? executor.model ?? ""),
      executionContext: clonePlain(next.executionContext ?? executor.executionContext ?? null),
      agentId: next.actorAgentId || executor.agentId || null,
    };
  }

  return next;
}
