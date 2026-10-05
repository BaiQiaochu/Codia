// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import {
  createMcpOAuthAuthorization,
  discoverMcpOAuth,
  exchangeMcpOAuthCode,
  refreshMcpOAuthToken,
  registerMcpOAuthClient,
} from "../plugins/mcp/lib/mcp-oauth.js";
import { McpHttpError } from "../plugins/mcp/lib/mcp-http-client.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function formBody(init) {
  return new URLSearchParams(String(init.body));
}

describe("MCP OAuth helpers", () => {
  it("discovers OAuth metadata from a WWW-Authenticate resource metadata challenge", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["files:read", "files:write"],
        });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          code_challenge_methods_supported: ["S256"],
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const metadata = await discoverMcpOAuth({
      connectorUrl: "https://mcp.example.com/mcp",
      fetchImpl,
    });

    expect(metadata.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(metadata.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(metadata.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(metadata.scope).toBe("files:read");
    expect(calls[0].init.method).toBe("POST");
  });

  it("falls back to protected resource well-known URLs when the challenge omits resource metadata", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === "https://mcp.example.com/public/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer scope="calendar:read"' },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com/tenant"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server/tenant") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const metadata = await discoverMcpOAuth({
      connectorUrl: "https://mcp.example.com/public/mcp",
      fetchImpl,
    });

    expect(metadata.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp");
    expect(metadata.authorizationEndpoint).toBe("https://auth.example.com/tenant/authorize");
    expect(metadata.scope).toBe("calendar:read");
    expect(calls).toContain("https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp");
  });

  it("creates an authorization URL with PKCE, resource, scope, and redirect URI", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const auth = await createMcpOAuthAuthorization({
      connector: {
        id: "github",
        url: "https://mcp.example.com/mcp",
        oauthClientId: "client-id",
        headers: {
          "MCP-Protocol-Version": "2024-11-05",
        },
      },
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      state: "state-123",
      codeVerifier: "verifier-123",
      codeChallenge: "challenge-123",
      fetchImpl,
    });

    const url = new URL(auth.url);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3210/api/plugins/mcp/oauth/callback");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(url.searchParams.get("scope")).toBe("files:read");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.session).toMatchObject({
      connectorId: "github",
      codeVerifier: "verifier-123",
      tokenEndpoint: "https://auth.example.com/token",
    });
    expect(JSON.parse(String(calls[0].init.body)).params.protocolVersion).toBe("2024-11-05");
    expect(calls[0].init.headers["MCP-Protocol-Version"]).toBe("2024-11-05");
  });

  it("exchanges an OAuth authorization code for connector token state", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://auth.example.com/token");
      expect(init.method).toBe("POST");
      return jsonResponse({
        access_token: "access-123",
        refresh_token: "refresh-123",
        expires_in: 3600,
        scope: "files:read",
        token_type: "Bearer",
      });
    });

    const token = await exchangeMcpOAuthCode({
      tokenEndpoint: "https://auth.example.com/token",
      code: "code-123",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      clientId: "client-id",
      clientSecret: "secret-123",
      codeVerifier: "verifier-123",
      resource: "https://mcp.example.com/mcp",
      fetchImpl,
    });

    const body = formBody(fetchImpl.mock.calls[0][1]);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-123");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("secret-123");
    expect(body.get("code_verifier")).toBe("verifier-123");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(token).toMatchObject({
      accessToken: "access-123",
      refreshToken: "refresh-123",
      expiresIn: 3600,
      scope: "files:read",
      tokenType: "Bearer",
    });
  });
});

describe("MCP OAuth dynamic client registration (RFC 7591)", () => {
  it("surfaces the registration endpoint and supported scopes/grant types from discovery", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          scopes_supported: ["files:read", "offline_access"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const metadata = await discoverMcpOAuth({
      connectorUrl: "https://mcp.example.com/mcp",
      fetchImpl,
    });

    expect(metadata.registrationEndpoint).toBe("https://auth.example.com/register");
    expect(metadata.scopesSupported).toEqual(["files:read", "offline_access"]);
    expect(metadata.grantTypesSupported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("registers a public client with the required RFC 7591 metadata", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://auth.example.com/register");
      expect(init.method).toBe("POST");
      return jsonResponse({
        client_id: "dcr-client-id",
        client_secret: "dcr-client-secret",
        registration_access_token: "rat-123",
        registration_client_uri: "https://auth.example.com/register/dcr-client-id",
      }, { status: 201 });
    });

    const result = await registerMcpOAuthClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      scope: "files:read offline_access",
      fetchImpl,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:3210/api/plugins/mcp/oauth/callback"]);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.scope).toBe("files:read offline_access");
    expect(typeof body.client_name).toBe("string");
    expect(fetchImpl.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");

    expect(result).toEqual({
      clientId: "dcr-client-id",
      clientSecret: "dcr-client-secret",
      registrationAccessToken: "rat-123",
      registrationClientUri: "https://auth.example.com/register/dcr-client-id",
    });
  });

  it("throws when the registration endpoint rejects the request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "invalid_redirect_uri", error_description: "redirect not allowed" },
      { status: 400 },
    ));

    await expect(registerMcpOAuthClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      fetchImpl,
    })).rejects.toThrow(/redirect not allowed/);
  });

  it("throws a structured error when DCR rejects with a non-JSON body", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    }));

    const err = await registerMcpOAuthClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      fetchImpl,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(502);
    expect(err.body).toContain("bad gateway");
    expect(err.message).toMatch(/dynamic client registration failed with status 502/i);
    expect(err.message).not.toMatch(/SyntaxError/i);
  });

  it("runs DCR when the connector has no client id and discovery offers a registration endpoint", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          scopes_supported: ["files:read"],
        });
      }
      if (String(url) === "https://auth.example.com/register") {
        expect(init.method).toBe("POST");
        return jsonResponse({ client_id: "auto-client", client_secret: "auto-secret" }, { status: 201 });
      }
      throw new Error(`unexpected ${url}`);
    });

    const auth = await createMcpOAuthAuthorization({
      connector: { id: "notion", url: "https://mcp.example.com/mcp" },
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      state: "state-dcr",
      codeVerifier: "verifier-dcr",
      codeChallenge: "challenge-dcr",
      fetchImpl,
    });

    const url = new URL(auth.url);
    expect(url.searchParams.get("client_id")).toBe("auto-client");
    // The DCR products must ride along in the session so the runtime can persist them.
    expect(auth.session).toMatchObject({
      clientId: "auto-client",
      clientSecret: "auto-secret",
      clientIdSource: "dcr",
    });
  });

  it("prefers a manually configured client id over DCR", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const auth = await createMcpOAuthAuthorization({
      connector: { id: "github", url: "https://mcp.example.com/mcp", oauthClientId: "manual-client" },
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      state: "state-manual",
      codeVerifier: "verifier-manual",
      codeChallenge: "challenge-manual",
      fetchImpl,
    });

    const url = new URL(auth.url);
    expect(url.searchParams.get("client_id")).toBe("manual-client");
    expect(auth.session.clientIdSource).toBe("manual");
    // Registration endpoint must never be hit when a manual client id is present.
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).not.toContain("https://auth.example.com/register");
  });

  it("errors (does not silently continue) when there is no client id and no registration endpoint", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(createMcpOAuthAuthorization({
      connector: { id: "nodcr", url: "https://mcp.example.com/mcp" },
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      fetchImpl,
    })).rejects.toThrow(/client/i);
  });

  it("appends offline_access to the authorization scope when the server supports it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === "https://mcp.example.com/mcp") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
          },
        });
      }
      if (String(url) === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (String(url) === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          scopes_supported: ["files:read", "offline_access"],
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const auth = await createMcpOAuthAuthorization({
      connector: { id: "github", url: "https://mcp.example.com/mcp", oauthClientId: "client-id" },
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      state: "state-scope",
      codeVerifier: "verifier-scope",
      codeChallenge: "challenge-scope",
      fetchImpl,
    });

    const url = new URL(auth.url);
    const scopes = (url.searchParams.get("scope") || "").split(" ");
    expect(scopes).toContain("files:read");
    expect(scopes).toContain("offline_access");
    // No duplication even though offline_access comes from a different source.
    expect(scopes.filter((s) => s === "offline_access")).toHaveLength(1);
    expect(auth.session.scope.split(" ")).toContain("offline_access");
  });
});

describe("MCP OAuth token refresh (RFC 6749 §6)", () => {
  it("exchanges a refresh token for a fresh access token in the same shape as code exchange", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://auth.example.com/token");
      expect(init.method).toBe("POST");
      return jsonResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
        scope: "files:read",
        token_type: "Bearer",
      });
    });

    const token = await refreshMcpOAuthToken({
      tokenEndpoint: "https://auth.example.com/token",
      refreshToken: "refresh-old",
      clientId: "client-id",
      clientSecret: "secret-123",
      scope: "files:read",
      resource: "https://mcp.example.com/mcp",
      fetchImpl,
    });

    const body = formBody(fetchImpl.mock.calls[0][1]);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-old");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("secret-123");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(token).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresIn: 3600,
      scope: "files:read",
      tokenType: "Bearer",
      tokenEndpoint: "https://auth.example.com/token",
    });
  });

  it("retains the existing refresh token when the server does not rotate it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: "access-new",
      expires_in: 3600,
      token_type: "Bearer",
    }));

    const token = await refreshMcpOAuthToken({
      tokenEndpoint: "https://auth.example.com/token",
      refreshToken: "refresh-old",
      clientId: "client-id",
      fetchImpl,
    });

    // RFC 6749 allows the AS to omit a new refresh_token; the old one stays valid.
    expect(token.refreshToken).toBe("refresh-old");
    expect(token.accessToken).toBe("access-new");
  });

  it("throws when the refresh grant is rejected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "invalid_grant", error_description: "refresh token expired" },
      { status: 400 },
    ));

    await expect(refreshMcpOAuthToken({
      tokenEndpoint: "https://auth.example.com/token",
      refreshToken: "refresh-old",
      clientId: "client-id",
      fetchImpl,
    })).rejects.toThrow(/refresh token expired/);
  });

  // #1286 ③a I1: a rejected refresh must carry the HTTP status AND the OAuth
  // error code so the three classification points (live-401 self-heal,
  // reconnect-attempt, pre-refresh) can recognize invalid_grant as auth-terminal
  //
  // failure that keeps hammering the token endpoint via backoff.
  it("throws a structured McpHttpError carrying status and oauthError on invalid_grant", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "invalid_grant", error_description: "refresh token expired" },
      { status: 400 },
    ));

    const err = await refreshMcpOAuthToken({
      tokenEndpoint: "https://auth.example.com/token",
      refreshToken: "refresh-old",
      clientId: "client-id",
      fetchImpl,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(400);
    expect(err.oauthError).toBe("invalid_grant");
    expect(err.message).toMatch(/refresh token expired/);
  });

  it("carries the HTTP status even when the body has no OAuth error code", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream exploded", { status: 503 }));

    const err = await refreshMcpOAuthToken({
      tokenEndpoint: "https://auth.example.com/token",
      refreshToken: "refresh-old",
      clientId: "client-id",
      fetchImpl,
    }).catch((e) => e);

    // A 5xx is transient (not auth-terminal): it must surface the status so the
    // runtime keeps backoff reconnect, and must NOT carry an auth-terminal code.
    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(503);
    expect(err.oauthError).toBe("");
  });

  it("propagates the OAuth error code from a rejected authorization-code exchange too", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "invalid_grant", error_description: "authorization code already used" },
      { status: 400 },
    ));

    const err = await exchangeMcpOAuthCode({
      tokenEndpoint: "https://auth.example.com/token",
      code: "code-123",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      clientId: "client-id",
      codeVerifier: "verifier-123",
      fetchImpl,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(400);
    expect(err.oauthError).toBe("invalid_grant");
  });
});
