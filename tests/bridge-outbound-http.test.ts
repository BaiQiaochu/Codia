import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_HTTP_MAX_RETRIES,
  BRIDGE_HTTP_RETRY_BASE_DELAY_MS,
  BRIDGE_HTTP_TIMEOUT_MS,
  BridgeHttpError,
  createBridgeOutboundHttp,
} from "../lib/bridge/outbound-http.ts";

function fakeResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn(async () => {}) },
    text: async () => "",
    json: async () => ({}),
  };
}

function networkError(code: string) {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`${code} 127.0.0.1:443`), { code }),
  });
}

function directResolver() {
  return { dispatcher: null, proxyUrl: "" };
}

describe("createBridgeOutboundHttp", () => {
  it("exports explicit timeout and retry constants", () => {
    expect(BRIDGE_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(BRIDGE_HTTP_MAX_RETRIES).toBeGreaterThan(0);
    expect(BRIDGE_HTTP_RETRY_BASE_DELAY_MS).toBeGreaterThan(0);
  });

  it("requires an explicit platform label", () => {
    expect(() => createBridgeOutboundHttp({} as any)).toThrow(/platform/);
  });

  it("requires an explicit stage on every request", async () => {
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl: vi.fn(async () => fakeResponse()),
      resolveDispatcher: directResolver,
    } as any);
    await expect(http.request({ url: "https://api.sgroup.qq.com/gateway" } as any))
      .rejects.toThrow(/stage/);
  });

  it("passes the per-URL proxy dispatcher resolved from the shared proxy source", async () => {
    const dispatcher = { dispatch: () => false };
    const inits: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      inits.push(init);
      return fakeResponse();
    });
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: (url: string) => ({
        dispatcher: url.startsWith("https://api.sgroup.qq.com") ? dispatcher : null,
        proxyUrl: url.startsWith("https://api.sgroup.qq.com") ? "http://127.0.0.1:7890" : "",
      }),
    } as any);

    await http.request({ stage: "gateway", url: "https://api.sgroup.qq.com/gateway" });
    expect(inits[0].dispatcher).toBe(dispatcher);

    await http.request({ stage: "token", url: "https://bots.qq.com/app/getAppAccessToken", method: "POST" });
    expect(inits[1].dispatcher).toBeUndefined();
  });

  it("aborts after the explicit timeout and reports stage/host/route without leaking the path", async () => {
    const fetchImpl = vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      });
    }));
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
    } as any);

    const err: any = await http.request({
      stage: "upload_part_put",
      url: "https://cos.example.com/part-1?sig=TOPSECRET",
      method: "PUT",
      timeoutMs: 20,
    }).then(
      () => { throw new Error("expected timeout"); },
      (e: any) => e,
    );

    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.timedOut).toBe(true);
    expect(err.stage).toBe("upload_part_put");
    expect(err.host).toBe("cos.example.com");
    expect(err.message).toContain("[qq:upload_part_put]");
    expect(err.message).toContain("cos.example.com");
    expect(err.message).toContain("20ms");
    expect(err.message).not.toContain("TOPSECRET");
    expect(err.message).not.toContain("/part-1");
  });

  it("retries idempotent requests on network failure with bounded exponential backoff", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw networkError("ECONNREFUSED");
      return fakeResponse();
    });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
      sleep,
    } as any);

    const res: any = await http.request({
      stage: "token",
      url: "https://bots.qq.com/app/getAppAccessToken",
      method: "POST",
      idempotent: true,
    });

    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]: any) => ms)).toEqual([
      BRIDGE_HTTP_RETRY_BASE_DELAY_MS,
      BRIDGE_HTTP_RETRY_BASE_DELAY_MS * 2,
    ]);
  });

  it("never auto-retries non-idempotent requests", async () => {
    const fetchImpl = vi.fn(async () => { throw networkError("ECONNRESET"); });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
      sleep,
    } as any);

    const err: any = await http.request({
      stage: "send_reply",
      url: "https://api.sgroup.qq.com/v2/users/user-openid/messages",
      method: "POST",
      body: "{}",
    }).then(
      () => { throw new Error("expected failure"); },
      (e: any) => e,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.attempts).toBe(1);
  });

  it("stops at the retry cap and surfaces attempts, route and the underlying cause", async () => {
    const fetchImpl = vi.fn(async () => { throw networkError("ETIMEDOUT"); });
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: () => ({
        dispatcher: { dispatch: () => false },
        proxyUrl: "http://alice:secret@proxy.local:8080",
      }),
      sleep,
    } as any);

    const err: any = await http.request({
      stage: "token",
      url: "https://bots.qq.com/app/getAppAccessToken",
      method: "POST",
      idempotent: true,
    }).then(
      () => { throw new Error("expected failure"); },
      (e: any) => e,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(BRIDGE_HTTP_MAX_RETRIES + 1);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.attempts).toBe(BRIDGE_HTTP_MAX_RETRIES + 1);
    expect(err.proxied).toBe(true);
    expect(err.message).toContain("[qq:token]");
    expect(err.message).toContain("bots.qq.com");
    expect(err.message).toContain("ETIMEDOUT");
    expect(err.message).toContain("proxy.local:8080");
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain("alice");
    expect(err.proxyUrl).not.toContain("secret");
    expect(err.cause?.message).toBe("fetch failed");
  });

  it("retries retryable HTTP statuses for idempotent requests and returns the final response as-is", async () => {
    const first = fakeResponse(503);
    const second = fakeResponse(200);
    const fetchImpl = vi.fn(async () => (fetchImpl.mock.calls.length === 1 ? first : second));
    const sleep = vi.fn(async () => {});
    const http = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl,
      resolveDispatcher: directResolver,
      sleep,
    } as any);

    const res: any = await http.request({
      stage: "gateway",
      url: "https://api.sgroup.qq.com/gateway",
      idempotent: true,
    });
    expect(res.status).toBe(200);
    expect(first.body.cancel).toHaveBeenCalled();

    const fetchOnce = vi.fn(async () => fakeResponse(503));
    const httpNoRetry = createBridgeOutboundHttp({
      platform: "qq",
      fetchImpl: fetchOnce,
      resolveDispatcher: directResolver,
      sleep,
    } as any);
    const res503: any = await httpNoRetry.request({
      stage: "send_reply",
      url: "https://api.sgroup.qq.com/v2/users/u/messages",
      method: "POST",
    });
    expect(res503.status).toBe(503);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });
});
