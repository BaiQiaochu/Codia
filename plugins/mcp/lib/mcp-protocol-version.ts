import { MCP_PROTOCOL_VERSION } from "./mcp-stdio-client.ts";

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

export function resolveInitialMcpProtocolVersion({ headers = {}, protocolVersion = "" }: any = {}) {
  const explicit = stringOrEmpty(protocolVersion);
  if (explicit) return explicit;
  return headerValue(headers, MCP_PROTOCOL_VERSION_HEADER) || MCP_PROTOCOL_VERSION;
}

export function headersWithoutMcpProtocolVersion(headers: any = {}) {
  const result: Record<string, any> = {};
  const protocolHeader = MCP_PROTOCOL_VERSION_HEADER.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof key !== "string" || key.toLowerCase() === protocolHeader) continue;
    result[key] = value;
  }
  return result;
}

function headerValue(headers: any, name: string) {
  const lower = name.toLowerCase();
  const found = Object.entries(headers || {}).find(([key, value]) => (
    typeof key === "string" &&
    key.toLowerCase() === lower &&
    typeof value === "string" &&
    value.trim()
  ));
  const value = found?.[1];
  return typeof value === "string" ? value.trim() : "";
}

function stringOrEmpty(value: any) {
  return typeof value === "string" ? value.trim() : "";
}
