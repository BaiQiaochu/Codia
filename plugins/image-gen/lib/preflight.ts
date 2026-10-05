const CREDENTIAL_PATTERNS = [
  /api\s*key/i,
  /credential/i,
  /no[_\s-]?credentials?/i,
  /not[_\s-]?configured/i,
  /unauthori[sz]ed/i,
  /\b401\b/,
];

export function classifyPreflightFailure(message) {
  const text = String(message || "");
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
    ? "missing_credentials"
    : "provider_failure";
}

export function mediaError(mediaType, code, message, extra = {}) {
  const text = String(message || "Media generation failed.");
  return {
    content: [{ type: "text", text }],
    details: {
      error: {
        ok: false,
        mediaType,
        code,
        message: text,
        ...extra,
      },
    },
  };
}

export function missingModel(mediaType, message) {
  return mediaError(mediaType, "missing_model", message);
}

export function taskFailure(mediaType, message, extra = {}) {
  return mediaError(mediaType, "task_failed", message, extra);
}

export async function runAdapterPreflight(adapter, submitCtx, mediaType) {
  if (typeof adapter?.checkAuth !== "function") return null;

  try {
    const result = await adapter.checkAuth(submitCtx);
    if (result?.ok !== false) return null;
    const message = result?.message || `${mediaType} provider authentication failed.`;
    return mediaError(mediaType, classifyPreflightFailure(message), message);
  } catch (err) {
    const message = err?.message || String(err);
    return mediaError(mediaType, classifyPreflightFailure(message), message);
  }
}
