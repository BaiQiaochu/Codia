// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  AGENT_PHONE_COMPACTION,
  filterAgentPhoneTools,
  getAgentPhonePermissionMode,
  getAgentPhoneSessionDir,
  isAgentPhoneSessionPath,
  shouldCompactAgentPhoneSession,
  shouldReuseAgentPhoneSession,
} from "../lib/conversations/agent-phone-session.js";
import { getStableFeatureDisabledToolNames as getAvailabilityDisabledToolNames } from "../core/tool-availability.js";

describe("agent phone session policy", () => {
  it("uses a stable safe session directory per conversation", () => {
    const dir = getAgentPhoneSessionDir("/agents/gsap", "dm:yui");
    const normalized = dir.replace(/\\/g, "/");
    expect(normalized).toContain("/agents/gsap/phone/sessions/");
    expect(normalized.split("/").at(-1)).not.toContain(":");
  });

  it("recognizes phone sessions so memory pipelines can exclude them", () => {
    expect(isAgentPhoneSessionPath("/agents/gsap/phone/sessions/ch_crew/session.jsonl")).toBe(true);
    expect(isAgentPhoneSessionPath("/agents/gsap/sessions/session.jsonl")).toBe(false);
  });

  it("maps phone tool modes to session permission modes", () => {
    expect(getAgentPhonePermissionMode("write")).toBe("operate");
    expect(getAgentPhonePermissionMode("read_only")).toBe("read_only");
    expect(getAgentPhonePermissionMode("unknown")).toBe("read_only");
  });

  it("compacts immediately at the hard 180K limit even when active", () => {
    expect(shouldCompactAgentPhoneSession({
      tokens: AGENT_PHONE_COMPACTION.HARD_TOKENS,
      isActive: true,
    })).toBe("hard");
  });

  it("only idle-compacts at 120K when not active", () => {
    expect(shouldCompactAgentPhoneSession({
      tokens: AGENT_PHONE_COMPACTION.IDLE_TOKENS,
      isActive: true,
    })).toBe(null);
    expect(shouldCompactAgentPhoneSession({
      tokens: AGENT_PHONE_COMPACTION.IDLE_TOKENS,
      isActive: false,
    })).toBe("idle");
  });

  it("reuses only recently active phone sessions", () => {
    const now = new Date("2026-05-25T12:00:00.000Z");
    expect(shouldReuseAgentPhoneSession({
      meta: { lastPhoneSessionUsedAt: "2026-05-25T11:45:00.000Z" },
      sessionExists: true,
      now,
    })).toBe(true);
    expect(shouldReuseAgentPhoneSession({
      meta: { lastPhoneSessionUsedAt: "2026-05-25T11:20:00.000Z" },
      sessionExists: true,
      now,
    })).toBe(false);
    expect(shouldReuseAgentPhoneSession({
      meta: { lastRefreshedDate: "2026-05-25" },
      sessionExists: true,
      now,
    })).toBe(false);
  });

  it("keeps phone schemas stable while excluding recursive communication and browser tools", () => {
    const built = {
      tools: [
        { name: "read" },
        { name: "write" },
        { name: "grep" },
        { name: "browser" },
      ],
      customTools: [
        { name: "search_memory" },
        { name: "record_experience" },
        { name: "dm" },
        { name: "web_fetch" },
      ],
    };

    const filtered = filterAgentPhoneTools(built, { toolMode: "read_only" });
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["read", "write", "grep"]);
    expect(filtered.customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
      "web_fetch",
    ]);
  });

  it("disables both channel and dm tools when the phone feature is off", () => {
    expect(getAvailabilityDisabledToolNames({ channelsEnabled: false })).toEqual(["channel", "dm"]);
  });
});
