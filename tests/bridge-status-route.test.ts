import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createBridgeRoute } from "../server/routes/bridge.js";

function createEngine(agent) {
  return {
    currentAgentId: agent.id,
    getAgent: vi.fn((id) => (id === agent.id ? agent : null)),
    getBridgeIndex: vi.fn(() => ({})),
  };
}

describe("bridge status route", () => {
  it("returns diagnostics metadata for wechat, whatsapp and qq", async () => {
    const now = Date.now();
    const agent = {
      id: "agent-1",
      config: {
        bridge: {
          qq: { enabled: true, appID: "qq-app", appSecret: "qq-secret" },
          whatsapp: { enabled: true },
          wechat: { enabled: true, botToken: "wx-token" },
        },
      },
    };
    const bridgeManager = {
      getStatus: vi.fn(() => ({
        qq: {
          status: "connected",
          adapterVersion: "qq-test-1",
          lastConnectedAt: now - 1_000,
          lastSyncAt: now - 2_000,
          retryCount: 0,
        },
        whatsapp: {
          status: "error",
          adapterVersion: "whatsapp-test-1",
          error: "ERR_CONNECTION_TIMED_OUT",
          errorType: "network_timeout",
          lastErrorAt: now - 3_000,
          retryCount: 2,
        },
        wechat: {
          status: "error",
          adapterVersion: "wechat-test-1",
          error: "session_expired",
          lastErrorAt: now - 4_000,
          retryCount: 1,
        },
      })),
    };

    const app = new Hono();
    app.route("/api", createBridgeRoute(createEngine(agent), bridgeManager));

    const res = await app.request("/api/bridge/status?agentId=agent-1");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.qq.lastConnectedAt).toBe(now - 1_000);
    expect(data.qq.adapter).toMatchObject({ platform: "qq", agentId: "agent-1", version: "qq-test-1" });
    expect(data.qq.capabilities.media.inputModes).toContain("local_file");
    expect(data.qq.lastSyncAt).toBe(now - 2_000);
    expect(data.qq.syncState).toBe("recent");
    expect(Array.isArray(data.qq.diagnose)).toBe(true);
    expect(data.whatsapp.errorType).toBe("network_timeout");
    expect(data.whatsapp.adapter).toMatchObject({ platform: "whatsapp", agentId: "agent-1", version: "whatsapp-test-1" });
    expect(Array.isArray(data.whatsapp.diagnose)).toBe(true);
    expect(data.whatsapp.diagnose.length).toBeGreaterThan(0);
    expect(data.whatsapp.retryCount).toBe(2);
    expect(data.whatsapp.capabilities.media.supportedKinds).toContain("document");
    expect(data.whatsapp.syncState).toBe("never");
    expect(data.wechat.lastErrorAt).toBe(now - 4_000);
    expect(data.wechat.adapter).toMatchObject({ platform: "wechat", agentId: "agent-1", version: "wechat-test-1" });
    expect(Array.isArray(data.wechat.diagnose)).toBe(true);
    expect(data.wechat.diagnose.length).toBeGreaterThan(0);
    expect(data.telegram.capabilities.media.inputModes).toContain("buffer");
    expect(data.feishu.capabilities.media.supportedKinds).toContain("image");
    expect(data.capabilities.surfaces).toEqual(["desktop", "pwa", "cli"]);
  });

  it("restarts a configured platform through reconnect route", async () => {
    const agent = {
      id: "agent-1",
      config: {
        bridge: {
          qq: { enabled: true, appID: "qq-app", appSecret: "qq-secret" },
        },
      },
    };
    const live = { qq: { status: "disconnected" } };
    const bridgeManager = {
      getStatus: vi.fn(() => live),
      stopPlatform: vi.fn((platform) => {
        live[platform] = { status: "disconnected" };
      }),
      startPlatformFromConfig: vi.fn((platform) => {
        live[platform] = { status: "connected", lastConnectedAt: 999 };
      }),
    };

    const app = new Hono();
    app.route("/api", createBridgeRoute(createEngine(agent), bridgeManager));

    const res = await app.request("/api/bridge/reconnect?agentId=agent-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "qq" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(bridgeManager.stopPlatform).toHaveBeenCalledWith("qq", "agent-1");
    expect(bridgeManager.startPlatformFromConfig).toHaveBeenCalledWith("qq", agent.config.bridge.qq, "agent-1");
  });

  it("returns a scan-required error when wechat has no token", async () => {
    const agent = {
      id: "agent-1",
      config: {
        bridge: {
          wechat: { enabled: true },
        },
      },
    };
    const bridgeManager = {
      getStatus: vi.fn(() => ({})),
      stopPlatform: vi.fn(),
      startPlatformFromConfig: vi.fn(),
    };

    const app = new Hono();
    app.route("/api", createBridgeRoute(createEngine(agent), bridgeManager));

    const res = await app.request("/api/bridge/reconnect?agentId=agent-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "wechat" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(false);
    expect(data.errorType).toBe("need_scan");
    expect(bridgeManager.startPlatformFromConfig).not.toHaveBeenCalled();
  });
});
