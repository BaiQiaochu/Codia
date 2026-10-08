export declare const COMPACTION_MODE_EXPERIMENT_ID: "session.compaction_mode";

export declare const COMPACTION_MODES: Readonly<{
  AUTO: "auto";
  CACHE_PRESERVING: "cache_preserving";
  PI_COMPATIBLE: "pi_compatible";
}>;

export type CompactionMode = typeof COMPACTION_MODES[keyof typeof COMPACTION_MODES];

export function normalizeCompactionMode(value: unknown): CompactionMode;
export function getResolvedCompactionMode(preferencesManager: unknown): CompactionMode;
