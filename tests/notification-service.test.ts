import { describe, expect, it, vi } from "vitest";
import { NotificationService, formatNotificationText } from "../lib/notifications/notification-service.js";

describe("NotificationService", () => {
  it("keeps legacy notify calls on the desktop channel", async () => {
    const desktopEvents = [];
    const service = new NotificationService({
      emitDesktop: (event) => desktopEvents.push(event),
      getBridgeManager: () => null,
    });

    const result = await service.notify({ title: "Reminder", body: "Drink water" }, { agentId: "G-SAP" });

    expect(desktopEvents).toEqual([
      { title: "Reminder", body: "Drink water", agentId: "G-SAP", desktopFocusPolicy: "always" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      deliveries: [{ channel: "desktop", status: "sent" }],
    });
  });

  it("passes desktop focus policy to the desktop notification boundary", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    await service.notify(
      {
        title: "Complete",
        body: "This turn has finished",
        desktopFocusPolicy: "when_unfocused",
      },
      { agentId: "G-SAP" },
    );

    expect(emitDesktop).toHaveBeenCalledWith({
      title: "Complete",
      body: "This turn has finished",
      agentId: "G-SAP",
      desktopFocusPolicy: "when_unfocused",
    });
  });

  it("passes the notification sessionPath to the desktop notification boundary", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    await service.notify(
      {
        title: "Complete",
        body: "This turn has finished",
        sessionPath: "/tmp/finished.jsonl",
      },
      { agentId: "G-SAP" },
    );

    expect(emitDesktop).toHaveBeenCalledWith({
      title: "Complete",
      body: "This turn has finished",
      agentId: "G-SAP",
      desktopFocusPolicy: "always",
      sessionPath: "/tmp/finished.jsonl",
    });
  });

  it("skips repeated notifications with the same explicit idempotency key", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const first = await service.notify(
      { title: "Reminder", body: "Drink water", idempotencyKey: "job:drink:2026-06-01T10:00" },
      { agentId: "G-SAP" },
    );
    const second = await service.notify(
      { title: "Reminder", body: "Drink water", idempotencyKey: "job:drink:2026-06-01T10:00" },
      { agentId: "G-SAP" },
    );

    expect(emitDesktop).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      ok: true,
      idempotencyKey: "job:drink:2026-06-01T10:00",
      deliveries: [{ channel: "desktop", status: "sent" }],
    });
    expect(second).toMatchObject({
      ok: true,
      idempotencyKey: "job:drink:2026-06-01T10:00",
      skipped: true,
      deliveries: [{
        channel: "notification",
        status: "skipped",
        reason: "duplicate notification",
      }],
    });
  });

  it("delivers explicit bridge owner notifications through BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "wechat",
        chatId: "wx-user",
        sessionKey: "wx_dm_wx-user@G-SAP",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    const result = await service.notify(
      {
        title: "AI Daily",
        body: "There are three updates today.",
        channels: ["bridge_owner"],
      },
      { agentId: "G-SAP" },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "AI Daily\n\nThere are three updates today.",
      "G-SAP",
      { contextPolicy: "record_when_delivered" },
    );
    expect(result).toMatchObject({
      ok: true,
      deliveries: [{
        channel: "bridge_owner",
        status: "sent",
        platform: "wechat",
        sessionKey: "wx_dm_wx-user@G-SAP",
      }],
    });
  });

  it("passes preferred bridge platforms to BridgeManager", async () => {
    const bridgeManager = {
      sendProactive: vi.fn().mockResolvedValue({
        platform: "feishu",
        chatId: "oc_owner",
        sessionKey: "fs_dm_owner@G-SAP",
      }),
    };
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => bridgeManager,
    });

    await service.notify(
      {
        title: "Reminder",
        body: "Body",
        channels: ["bridge_owner"],
        bridgePlatforms: ["feishu"],
      },
      { agentId: "G-SAP" },
    );

    expect(bridgeManager.sendProactive).toHaveBeenCalledWith(
      "Reminder\n\nBody",
      "G-SAP",
      {
        contextPolicy: "record_when_delivered",
        bridgePlatforms: ["feishu"],
      },
    );
  });

  it("reports explicit bridge owner delivery failure when the channel is unavailable", async () => {
    const service = new NotificationService({
      emitDesktop: vi.fn(),
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI Daily", body: "Body", channels: ["bridge_owner"] },
      { agentId: "G-SAP" },
    );

    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([{
      channel: "bridge_owner",
      status: "failed",
      error: "bridge manager unavailable",
    }]);
  });

  it("fails unsupported explicit channels instead of falling back to desktop", async () => {
    const emitDesktop = vi.fn();
    const service = new NotificationService({
      emitDesktop,
      getBridgeManager: () => null,
    });

    const result = await service.notify(
      { title: "AI Daily", body: "Body", channels: ["sms"] },
      { agentId: "G-SAP" },
    );

    expect(emitDesktop).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.deliveries).toEqual([{
      channel: "sms",
      status: "failed",
      error: "unsupported notification channel: sms",
    }]);
  });
});

describe("formatNotificationText", () => {
  it("uses the exact user-visible text for bridge delivery", () => {
    expect(formatNotificationText("Title", "Body")).toBe("Title\n\nBody");
    expect(formatNotificationText("", "Body")).toBe("Body");
    expect(formatNotificationText("Title", "")).toBe("Title");
  });
});
