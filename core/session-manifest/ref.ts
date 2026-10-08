export type SessionRef = {
  sessionId: string;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
};

export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sessionRefFromManifest(manifest: any, legacySessionPath?: unknown): SessionRef {
  if (!manifest?.sessionId) {
    throw new Error("sessionRefFromManifest requires a manifest with sessionId");
  }
  return {
    sessionId: manifest.sessionId,
    sessionPath: textOrNull(manifest.currentLocator?.path),
    legacySessionPath: textOrNull(legacySessionPath),
  };
}

export function sessionRefInputLegacyPath(ref: any): string | null {
  if (!ref || typeof ref !== "object") return null;
  return textOrNull(ref.sessionPath) || textOrNull(ref.path);
}
