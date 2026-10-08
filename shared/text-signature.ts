export type AssistantTextPhase = "commentary" | "final_answer";

export interface AssistantTextSignature {
  v?: number;
  id?: string;
  phase?: AssistantTextPhase;
}

export function parseAssistantTextSignature(value: unknown): AssistantTextSignature | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const phase = record.phase;
    if (phase !== "commentary" && phase !== "final_answer") return null;
    return {
      ...(typeof record.v === "number" ? { v: record.v } : {}),
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      phase,
    };
  } catch {
    return null;
  }
}

export function getAssistantTextPhase(block: unknown): AssistantTextPhase | null {
  if (!block || typeof block !== "object") return null;
  const signature = parseAssistantTextSignature((block as Record<string, unknown>).textSignature);
  return signature?.phase || null;
}

export function isAssistantCommentaryTextBlock(block: unknown): boolean {
  return getAssistantTextPhase(block) === "commentary";
}
