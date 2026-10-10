function cleanToken(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value.trim() : "";
}

function extractAuthorizationToken(value) {
  const header = cleanToken(value);
  if (!header) return "";

  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer?.[1]) return bearer[1].trim();

  const token = /^Token\s+(.+)$/i.exec(header);
  if (token?.[1]) return token[1].trim();

  return "";
}

function extractApiKeyHeader(getHeader) {
  return cleanToken(getHeader("x-api-key"))
    || cleanToken(getHeader("x-codia-api-key"))
    || cleanToken(getHeader("x-codia-api-key"));
}

function extractTokenFromSearchParams(params) {
  return cleanToken(params.get("token"))
    || cleanToken(params.get("api_key"))
    || cleanToken(params.get("apikey"));
}

export function extractAccessTokenFromHono(c, { allowQuery = false } = {}) {
  const fromHeader = extractAuthorizationToken(c.req.header("authorization"))
    || extractApiKeyHeader((name) => c.req.header(name));
  if (fromHeader) return fromHeader;
  if (!allowQuery) return "";

  const url = new URL(c.req.url);
  return extractTokenFromSearchParams(url.searchParams);
}

export function extractAccessTokenFromNodeRequest(req, { allowQuery = false } = {}) {
  const headers = req?.headers || {};
  const getHeader = (name) => headers[name] ?? headers[name.toLowerCase()];
  const fromHeader = extractAuthorizationToken(getHeader("authorization"))
    || extractApiKeyHeader(getHeader);
  if (fromHeader) return fromHeader;
  if (!allowQuery) return "";

  const url = new URL(req?.url || "/", `http://${headers.host || "127.0.0.1"}`);
  return extractTokenFromSearchParams(url.searchParams);
}
