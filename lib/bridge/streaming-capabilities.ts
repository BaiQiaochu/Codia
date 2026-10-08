const STREAMING_MODES = new Set(["draft", "edit_message", "block", "batch"]);

export function createStreamingCapabilities({
  platform,
  mode,
  scopes = ["dm"],
  minIntervalMs = 500,
  maxChars = 4096,
  renderer = mode === "edit_message" ? "post" : "text",
  receiptMode = mode === "edit_message" ? "fold_into_stream" : "independent",
  source = "",
}) {
  if (!platform) throw new Error("streaming capability requires platform");
  if (!STREAMING_MODES.has(mode)) throw new Error(`unsupported streaming mode: ${mode}`);
  return Object.freeze({
    platform,
    mode,
    scopes: Object.freeze([...scopes]),
    minIntervalMs,
    maxChars,
    renderer,
    receiptMode,
    source,
  });
}
