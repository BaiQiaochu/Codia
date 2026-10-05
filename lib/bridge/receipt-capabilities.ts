const RECEIPT_MODES = new Set(["text", "native_typing"]);

export function createReceiptCapabilities({
  platform,
  mode,
  scopes = ["dm"],
  refreshIntervalMs = 0,
  cancellable = false,
  source = "",
}) {
  if (!platform) throw new Error("receipt capability requires platform");
  if (!RECEIPT_MODES.has(mode)) throw new Error(`unsupported receipt mode: ${mode}`);
  return Object.freeze({
    platform,
    mode,
    scopes: Object.freeze([...scopes]),
    refreshIntervalMs,
    cancellable,
    source,
  });
}
