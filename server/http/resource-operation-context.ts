type ApiResourceOperationContextOptions = {
  reason?: unknown;
  sessionId?: unknown;
  sessionPath?: unknown;
  requestId?: unknown;
  principal?: Record<string, unknown> | null;
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function requestIdFromHono(c) {
  return nonEmptyString(c?.req?.header?.("x-request-id"))
    || nonEmptyString(c?.req?.header?.("x-correlation-id"))
    || null;
}

export function createApiResourceOperationContext(options: ApiResourceOperationContextOptions = {}) {
  const principal = options.principal && typeof options.principal === "object"
    ? options.principal
    : {};
  const sessionId = nonEmptyString(options.sessionId) || nonEmptyString(principal.sessionId);
  const sessionPath = nonEmptyString(options.sessionPath) || nonEmptyString(principal.sessionPath);
  const requestId = nonEmptyString(options.requestId) || nonEmptyString(principal.requestId);

  return {
    source: "api",
    reason: nonEmptyString(options.reason) || "resource_io_route",
    sessionId,
    sessionPath,
    requestId,
    principal: {
      kind: "api",
      ...principal,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}
