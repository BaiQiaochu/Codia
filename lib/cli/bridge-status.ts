// @ts-nocheck
const BRIDGE_PLATFORMS = ["telegram", "feishu", "qq", "wechat", "whatsapp"];

export async function readBridgeStatusSafe(client) {
  try {
    return await client.get("/bridge/status");
  } catch {
    return {};
  }
}

export function formatBridgeCliSummary(bridge = {}) {
  return BRIDGE_PLATFORMS
    .map((name) => {
      const item = bridge?.[name] || {};
      return `${name}:${item.status || "disconnected"}/${item.configured ? "cfg" : "no-cfg"}/${formatBridgeCapabilityShort(item.capabilities)}/${formatBridgeDiagnosticsShort(item)}`;
    })
    .join(" ");
}

export function formatBridgeDiagnosticsShort(item = {}) {
  const retry = Number.isFinite(item.retryCount) ? item.retryCount : 0;
  const version = item.adapter?.version ? `adapter:${item.adapter.version}` : "adapter:none";
  const sync = item.syncState || (item.lastSyncAt ? "idle" : "never");
  return `${version},sync:${sync},retry:${retry}`;
}

export function formatBridgeCapabilityShort(capabilities = {}) {
  const media = capabilities?.media;
  if (!media) return "media:none";
  const kinds = Array.isArray(media.supportedKinds) && media.supportedKinds.length
    ? media.supportedKinds.join("+")
    : "none";
  const modes = Array.isArray(media.inputModes) && media.inputModes.length
    ? media.inputModes.join("+")
    : "none";
  return `media:${kinds}@${modes}`;
}
