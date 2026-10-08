function parseNodeMajor(nodeVersion = process.versions.node): number {
  const match = String(nodeVersion || "").match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function assertSupportedServerEntry(
  serverEntry: string,
  nodeVersion = process.versions.node,
): void {
  const entry = String(serverEntry || "").split(/[?#]/, 1)[0].toLowerCase();
  if (entry.endsWith(".ts") && parseNodeMajor(nodeVersion) < 24) {
    throw new Error("[server-bootstrap] TypeScript source entry requires Node 24 or a prebuilt JavaScript bundle");
  }
}
