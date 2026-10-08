import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createBridgeRoute } from "../server/routes/bridge.ts";

function mergeBridgeConfig(target: any, patch: any) {
  const nextBridge = { ...(target.config.bridge || {}) };
  for (const [platform, value] of Object.entries(patch.bridge || {})) {
    nextBridge[platform] = {
      ...(nextBridge as any)[platform],
      ...(value as any),
    };
  }
  target.config.bridge = nextBridge;
}

function makeApp(agentPatch: any = {}, servicePatch: any = {}) {
  const agent: any = {
    id: "agent-1",
    config: {
      bridge: {
        agentlyMail: { enabled: true, email: "agent@qq.com", lastVerifiedAt: 123 },
        ...(agentPatch.bridge || {}),
      },
    },
    updateConfig: vi.fn((patch) => mergeBridgeConfig(agent, patch)),
    ...agentPatch,
  };
  const engine = {
    currentAgentId: agent.id,
    getAgent: vi.fn((id) => (id === agent.id ? agent : null)),
    getBridgeIndex: vi.fn(() => ({})),
  };
  const bridgeManager = {
    getStatus: vi.fn(() => ({})),
    stopPlatform: vi.fn(),
    startPlatformFromConfig: vi.fn(),
  };
  const agentlyMail = {
    checkCli: vi.fn(async () => ({ available: true, version: "1.2.3" })),
    startAuthLogin: vi.fn(async () => ({
      authUrl: "https://agent.qq.com/auth/login?ticket=a%2Fb+c&state=raw_123",
      raw: "auth output",
    })),
    verify: vi.fn(async () => ({ ok: true, email: "verified@qq.com", raw: "verified" })),
    ...servicePatch,
  };
  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, bridgeManager, { agentlyMail }));
  return { app, agent, bridgeManager, agentlyMail };
}

describe("bridge agently mail route", () => {
  it("reports QQ Mail Agent Mail separately from QQ bot credentials", async () => {
    const { app } = makeApp({
      config: {
        bridge: {
          agentlyMail: { enabled: true, email: "agent@qq.com", lastVerifiedAt: 123 },
          qq: { enabled: true },
        },
      },
    });

    const res = await app.request("/api/bridge/status?agentId=agent-1");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.qq.configured).toBe(false);
    expect(data.agentlyMail).toMatchObject({
      configured: true,
      email: "agent@qq.com",
      authenticated: true,
      enabled: true,
      lastVerifiedAt: 123,
    });
    expect(data.agentlyMail.capabilities.text.reply).toBe(true);
    expect(data.agentlyMail.capabilities.media.inputModes).toEqual(expect.arrayContaining(["buffer", "remote_url", "public_url"]));
    expect(data.agentlyMail.capabilities.media.supportedKinds).toEqual(expect.arrayContaining(["image", "video", "audio", "document"]));
  });

  it("returns the raw OAuth URL from agently-cli auth login", async () => {
    const { app, agentlyMail } = makeApp();

    const res = await app.request("/api/bridge/agently-mail/auth/start?agentId=agent-1", {
      method: "POST",
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.authUrl).toBe("https://agent.qq.com/auth/login?ticket=a%2Fb+c&state=raw_123");
    expect(agentlyMail.startAuthLogin).toHaveBeenCalledTimes(1);
  });

  it("verifies the mailbox and stores the binding on the selected agent", async () => {
    const { app, agent, bridgeManager } = makeApp({
      config: { bridge: { agentlyMail: { enabled: false } } },
    });

    const res = await app.request("/api/bridge/agently-mail/verify?agentId=agent-1", {
      method: "POST",
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, email: "verified@qq.com" });
    expect(agent.config.bridge.agentlyMail).toMatchObject({
      enabled: true,
      email: "verified@qq.com",
    });
    expect(bridgeManager.startPlatformFromConfig).toHaveBeenCalledWith(
      "agentlyMail",
      expect.objectContaining({ enabled: true, email: "verified@qq.com" }),
      "agent-1",
    );
  });
});
