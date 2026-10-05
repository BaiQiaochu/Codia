import { SettingsManager } from "../lib/pi-sdk/index.ts";
import { getSafeSessionTokenSettings } from "./model-token-limits.ts";

/** Default per-session settings. */
export function createDefaultSettings(model) {
  const compaction = getSafeSessionTokenSettings(model);
  return SettingsManager.inMemory({
    compaction: { enabled: true, ...compaction },
  });
}
