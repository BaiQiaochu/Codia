export const COMPACTION_MODE_EXPERIMENT_ID = "session.compaction_mode";

export const COMPACTION_MODES = Object.freeze({
  AUTO: "auto",
  CACHE_PRESERVING: "cache_preserving",
  PI_COMPATIBLE: "pi_compatible",
} as const);

export type CompactionMode = typeof COMPACTION_MODES[keyof typeof COMPACTION_MODES];

const KNOWN_COMPACTION_MODES = new Set<string>(Object.values(COMPACTION_MODES));

export function normalizeCompactionMode(value: unknown): CompactionMode {
  const mode = typeof value === "string" ? value : "";
  return KNOWN_COMPACTION_MODES.has(mode) ? mode as CompactionMode : COMPACTION_MODES.AUTO;
}

export function getResolvedCompactionMode(preferencesManager: unknown): CompactionMode {
  return normalizeCompactionMode(
    (preferencesManager as { getExperimentValue?: (id: string) => unknown } | null | undefined)
      ?.getExperimentValue?.(COMPACTION_MODE_EXPERIMENT_ID),
  );
}
