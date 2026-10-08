import { describe, expect, it } from "vitest";

describe("websocket auth tickets", () => {
  it("issues one-time tickets scoped to websocket transport", async () => {
    const { createWebSocketTicketService } = await import("../core/ws-auth-ticket.ts");
    const service = createWebSocketTicketService({
      now: () => "2026-06-20T00:00:00.000Z",
      ttlMs: 30_000,
    });
    const principal = {
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      userId: "user_1",
      studioId: "studio_1",
      scopes: ["chat"],
    };

    const issued = service.issueTicket(principal, { connectionKind: "lan", path: "/ws" });

    expect(issued.ticket).toMatch(/^gsap_ws_/);
    expect(issued.expiresAt).toBe("2026-06-20T00:00:30.000Z");
    expect(service.consumeTicket(issued.ticket, { connectionKind: "lan", path: "/ws" })).toMatchObject({
      kind: "device",
      connectionKind: "lan",
      scopes: ["chat"],
    });
    expect(service.consumeTicket(issued.ticket, { connectionKind: "lan", path: "/ws" })).toBeNull();
  });

  it("rejects tickets replayed on a different transport or route", async () => {
    const { createWebSocketTicketService } = await import("../core/ws-auth-ticket.ts");
    const service = createWebSocketTicketService({
      now: () => "2026-06-20T00:00:00.000Z",
      ttlMs: 30_000,
    });
    const principal = {
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      userId: "user_1",
      studioId: "studio_1",
      scopes: ["chat"],
    };
    const issued = service.issueTicket(principal, { connectionKind: "lan", path: "/ws" });

    expect(service.consumeTicket(issued.ticket, { connectionKind: "custom_remote", path: "/ws" })).toBeNull();
    expect(service.consumeTicket(issued.ticket, { connectionKind: "lan", path: "/api/chat" })).toBeNull();
    expect(service.consumeTicket(issued.ticket, { connectionKind: "lan", path: "/ws" })).toBeNull();
  });

  it("lets websocket principal resolution consume a valid ticket once", async () => {
    const { createWebSocketTicketService } = await import("../core/ws-auth-ticket.ts");
    const { resolveHttpRequestPrincipal } = await import("../server/http/request-principal.ts");
    const service = createWebSocketTicketService({
      now: () => "2026-06-20T00:00:00.000Z",
      ttlMs: 30_000,
    });
    const issued = service.issueTicket({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      userId: "user_1",
      studioId: "studio_1",
      scopes: ["chat"],
    }, { connectionKind: "lan", path: "/ws" });
    const authService = {
      authenticateRequestDetailed: () => ({
        principal: null,
        denied: {
          error: "forbidden",
          reason: "missing_credential",
          connectionKind: "lan",
        },
      }),
    };
    const makeContext = () => ({
      req: {
        method: "GET",
        url: `http://gsap.local/ws?wsTicket=${issued.ticket}`,
        header: () => null,
        query: (key: string) => (key === "wsTicket" ? issued.ticket : null),
      },
    });

    expect(resolveHttpRequestPrincipal(makeContext(), {}, {
      serverAuthService: authService,
      wsTicketService: service,
      connectionKind: "lan",
    })).toMatchObject({
      ok: true,
      principal: {
        kind: "device",
        userId: "user_1",
        studioId: "studio_1",
      },
    });

    expect(resolveHttpRequestPrincipal(makeContext(), {}, {
      serverAuthService: authService,
      wsTicketService: service,
      connectionKind: "lan",
    })).toMatchObject({
      ok: false,
      status: 403,
      body: {
        reason: "invalid_ws_ticket",
      },
    });
  });
});
