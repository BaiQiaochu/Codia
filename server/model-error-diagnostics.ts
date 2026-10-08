import { redactLogText } from "../shared/log-redactor.ts";

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
};

function asErrorLike(value: unknown): ErrorLike {
  return value && typeof value === "object" ? value as ErrorLike : {};
}

function errorText(value: unknown): string {
  const error = asErrorLike(value);
  return String(error.message ?? value ?? "Unknown error");
}

function errorCode(value: unknown): string {
  const error = asErrorLike(value);
  return error.code === null || error.code === undefined ? "" : String(error.code);
}

function errorStatus(value: unknown): number | undefined {
  const error = asErrorLike(value);
  const status = Number(error.status ?? error.statusCode);
  return Number.isFinite(status) ? status : undefined;
}

function errorChain(error: unknown): unknown[] {
  const chain = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current) && chain.length < 4) {
    chain.push(current);
    seen.add(current);
    current = asErrorLike(current).cause;
  }
  return chain;
}

function redactDiagnosticText(value: unknown): string {
  return redactLogText(value)
    .replace(
      /((?:^|[\s,{])(?:authorization|cookie|set-cookie|x-[a-z0-9-]+)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,;}\r\n]+)/gi,
      "$1[redacted]",
    )
    .slice(0, 2_000);
}

export function classifyModelError(error: unknown): string {
  const chain = errorChain(error);
  const text = chain.map((item) => `${errorCode(item)} ${errorText(item)}`).join(" ").toLowerCase();
  const status = chain.map(errorStatus).find((value) => value !== undefined);

  if (
    text.includes("err_invalid_char")
    || text.includes("bytestring")
    || (text.includes("header") && /(invalid character|control character|greater than 255|cannot convert)/.test(text))
  ) return "invalid_request_header";
  if (status === 408 || status === 504 || /(timed? ?out|timeout|etimedout|connect_timeout)/.test(text)) return "timeout";
  if (status === 401 || status === 403 || /(unauthorized|forbidden|authentication)/.test(text)) return "authentication";
  if (status === 429 || /(rate.?limit|too many requests)/.test(text)) return "rate_limit";
  if (/(aborted|aborterror|cancelled|canceled)/.test(text)) return "aborted";
  if (/(econnreset|econnrefused|enotfound|fetch failed|network)/.test(text)) return "network";
  if (status !== undefined && status >= 400) return "provider_error";
  return "unknown";
}

function summarizeError(value: unknown) {
  const error = asErrorLike(value);
  const status = errorStatus(value);
  return {
    name: redactDiagnosticText(error.name ?? (value instanceof Error ? value.name : "Error")),
    message: redactDiagnosticText(errorText(value)),
    ...(error.code !== null && error.code !== undefined
      ? { code: redactDiagnosticText(String(error.code)) }
      : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function summarizeModel(model: unknown) {
  const value = model && typeof model === "object" ? model as Record<string, unknown> : {};
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const idValue = value.id ?? value.modelId;
  const id = typeof idValue === "string" ? idValue.trim() : "";
  if (!provider && !id) return undefined;
  return {
    ...(provider ? { provider: redactDiagnosticText(provider) } : {}),
    ...(id ? { id: redactDiagnosticText(id) } : {}),
  };
}

export function buildModelErrorDiagnostic(error: unknown, model: unknown) {
  const chain = errorChain(error);
  return {
    message: redactDiagnosticText(errorText(error)),
    model: summarizeModel(model),
    details: {
      classification: classifyModelError(error),
      error: summarizeError(error),
      ...(chain.length > 1 ? { cause: summarizeError(chain[chain.length - 1]) } : {}),
    },
  };
}
