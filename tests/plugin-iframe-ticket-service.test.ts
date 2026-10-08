import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  issuePluginIframeTicket,
  PluginIframeTicketError,
  verifyPluginIframeTicket,
} from "../core/plugin-iframe-ticket-service.js";

describe("plugin iframe ticket service", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function home() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-plugin-iframe-ticket-"));
    return tmpDir;
  }

  it("issues short-lived surface scoped tickets", () => {
    const gsapHome = home();
    const issued = issuePluginIframeTicket({
      gsapHome,
      pluginId: "calendar",
      surfacePath: "/panel?view=week",
      principalId: "user-1",
      now: "2026-06-05T00:00:00.000Z",
    });

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(issued.pluginId).toBe("calendar");

    const verified = verifyPluginIframeTicket({
      gsapHome,
      ticket: issued.ticket,
      pluginId: "calendar",
      surfacePath: "/panel?view=week",
      now: "2026-06-05T00:01:00.000Z",
    });
    expect(verified.principalId).toBe("user-1");
    expect(verified.surfacePath).toBe("/panel?view=week");
  });

  it("rejects tickets replayed against a different plugin surface", () => {
    const gsapHome = home();
    const issued = issuePluginIframeTicket({
      gsapHome,
      pluginId: "calendar",
      surfacePath: "/panel",
      principalId: "user-1",
      now: "2026-06-05T00:00:00.000Z",
    });

    expect(() => verifyPluginIframeTicket({
      gsapHome,
      ticket: issued.ticket,
      pluginId: "calendar",
      surfacePath: "/settings",
      now: "2026-06-05T00:01:00.000Z",
    })).toThrow(PluginIframeTicketError);
  });
});
