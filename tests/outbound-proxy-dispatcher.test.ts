import { afterEach, describe, expect, it } from "vitest";
import { createOutboundProxyRuntime, fetchDispatcherForUrl } from "../lib/net/outbound-proxy.ts";

describe("fetchDispatcherForUrl", () => {
  const runtime = createOutboundProxyRuntime({ log: () => {}, warn: () => {}, env: {} });

  afterEach(() => {
    runtime.reset();
  });

  it("resolves a cached undici dispatcher for proxied targets", () => {
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });

    const first = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});
    expect(first.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(first.dispatcher).toBeTruthy();

    const second = fetchDispatcherForUrl("https://bots.qq.com/app/getAppAccessToken", {});
    expect(second.dispatcher).toBe(first.dispatcher);
  });

  it("returns no dispatcher in direct mode", () => {
    runtime.apply({ mode: "direct" });
    expect(fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {})).toEqual({
      dispatcher: null,
      proxyUrl: "",
    });
  });

  it("honors noProxy bypass from the shared proxy config", () => {
    runtime.apply({
      mode: "manual",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "api.sgroup.qq.com",
    });
    expect(fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {}).dispatcher).toBeNull();
    expect(fetchDispatcherForUrl("https://bots.qq.com/app/getAppAccessToken", {}).dispatcher).toBeTruthy();
  });

  it("rebuilds the dispatcher cache when a new proxy config is applied", () => {
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });
    const before = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});

    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:9999" });
    const after = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});

    expect(after.proxyUrl).toBe("http://127.0.0.1:9999");
    expect(after.dispatcher).not.toBe(before.dispatcher);
  });

  it("supports socks5 proxy urls like the WebSocket path does", () => {
    runtime.apply({ mode: "manual", httpsProxy: "socks5://127.0.0.1:1080" });
    const resolved = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});
    expect(resolved.proxyUrl).toBe("socks5://127.0.0.1:1080");
    expect(resolved.dispatcher).toBeTruthy();
  });
});
