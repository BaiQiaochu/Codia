// @ts-nocheck
/**
 * tests/outbound-proxy-diagnostics.test.js
 *
 * TDD 覆盖两个诊断可见性改动：
 * 1. createOutboundProxyRuntime.apply() 在 system-env 时调用 warn() 输出明确的启动提示
 * 2. 检测到 system-env 时 warn 消息包含代理地址
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOutboundProxyRuntime } from "../lib/net/outbound-proxy.ts";

describe("outbound-proxy startup diagnostics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls warn with proxy address when mode=system and env contains HTTP_PROXY", () => {
    const warnCalls = [];
    const runtime = createOutboundProxyRuntime({
      log: () => {},
      warn: (msg) => warnCalls.push(msg),
      env: { HTTP_PROXY: "http://127.0.0.1:7890" },
    });

    runtime.apply({ mode: "system" });

    // Should have exactly one warn call
    expect(warnCalls).toHaveLength(1);
    // Warn message must mention the proxy address
    expect(warnCalls[0]).toContain("http://127.0.0.1:7890");
  });

  it("does NOT call warn when mode=system but no proxy is set in env", () => {
    const warnCalls = [];
    const runtime = createOutboundProxyRuntime({
      log: () => {},
      warn: (msg) => warnCalls.push(msg),
      env: {},
    });

    runtime.apply({ mode: "system" });

    expect(warnCalls).toHaveLength(0);
  });

  it("does NOT call warn when mode=direct", () => {
    const warnCalls = [];
    const runtime = createOutboundProxyRuntime({
      log: () => {},
      warn: (msg) => warnCalls.push(msg),
      env: { HTTP_PROXY: "http://127.0.0.1:7890" },
    });

    runtime.apply({ mode: "direct" });

    expect(warnCalls).toHaveLength(0);
  });

  it("does NOT call warn when mode=manual", () => {
    const warnCalls = [];
    const runtime = createOutboundProxyRuntime({
      log: () => {},
      warn: (msg) => warnCalls.push(msg),
      env: { HTTP_PROXY: "http://127.0.0.1:7890" },
    });

    runtime.apply({ mode: "manual", httpProxy: "http://192.168.1.1:3128" });

    expect(warnCalls).toHaveLength(0);
  });

  it("warn message includes instruction to switch to direct", () => {
    const warnCalls = [];
    const runtime = createOutboundProxyRuntime({
      log: () => {},
      warn: (msg) => warnCalls.push(msg),
      env: { HTTPS_PROXY: "http://proxy.corp.example:8080" },
    });

    runtime.apply({ mode: "system" });

    expect(warnCalls).toHaveLength(1);
    // Should contain actionable guidance
    const msg = warnCalls[0].toLowerCase();
    expect(msg).toMatch(/direct|设置|setting/);
  });
});
