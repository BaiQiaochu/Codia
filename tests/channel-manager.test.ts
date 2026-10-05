/**
 * ChannelManager 单元测试
 *
  * */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock debug-log to prevent file I/O
import { vi } from "vitest";
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { ChannelManager } from "../core/channel-manager.js";
import { getChannelMemberRoles } from "../lib/channels/channel-store.js";
import { t } from "../server/i18n.js";

// ── Helpers ──

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channel-test-"));
}

function writeChannelMd(channelsDir, name, members, intro = "") {
  const lines = ["---"];
  lines.push(`members: [${members.join(", ")}]`);
  if (intro) lines.push(`intro: "${intro}"`);
  lines.push("---", "");
  fs.writeFileSync(path.join(channelsDir, `${name}.md`), lines.join("\n"), "utf-8");
}

function readMembers(channelsDir, name) {
  const content = fs.readFileSync(path.join(channelsDir, `${name}.md`), "utf-8");
  const match = content.match(/members:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

// ── Tests ──

describe("ChannelManager", () => {
  let tmpDir, channelsDir, agentsDir, userDir, manager;

  beforeEach(() => {
    tmpDir = mktemp();
    channelsDir = path.join(tmpDir, "channels");
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    manager = new ChannelManager({
      channelsDir,
      agentsDir,
      userDir,
      getHub: () => null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("deleteChannelByName", () => {
    it("deletes channel file", () => {
      writeChannelMd(channelsDir, "test-ch", ["a", "b"]);
      expect(fs.existsSync(path.join(channelsDir, "test-ch.md"))).toBe(true);

      manager.deleteChannelByName("test-ch");
      expect(fs.existsSync(path.join(channelsDir, "test-ch.md"))).toBe(false);
    });

    it("throws on non-existent channel", () => {
      expect(() => manager.deleteChannelByName("nope")).toThrow(
        t("error.channelNotFoundById", { id: "nope" }),
      );
    });

    it("cleans up agent bookmark references", () => {
      writeChannelMd(channelsDir, "general", ["agent-a"]);

      // Create agent dir (deleteChannelByName scans agentsDir for bookmark cleanup)
      const agentDir = path.join(agentsDir, "agent-a");
      fs.mkdirSync(agentDir, { recursive: true });

      manager.deleteChannelByName("general");

      // Channel file should be gone
      expect(fs.existsSync(path.join(channelsDir, "general.md"))).toBe(false);
    });
  });

  describe("setupChannelsForNewAgent", () => {
    it("creates ch_crew channel if not exists", () => {
      const agentDir = path.join(agentsDir, "new-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: New\n", "utf-8");

      manager.setupChannelsForNewAgent("new-agent");

      expect(fs.existsSync(path.join(channelsDir, "ch_crew.md"))).toBe(true);
      const members = readMembers(channelsDir, "ch_crew");
      expect(members).toContain("new-agent");
      const content = fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8");
      expect(content).toContain("ch_crew");
      expect(content).not.toContain("error.defaultChannelName");
      expect(getChannelMemberRoles(path.join(channelsDir, "ch_crew.md"))).toEqual({
        "new-agent": "project_manager",
      });
    });

    it("adds to existing ch_crew channel", () => {
      writeChannelMd(channelsDir, "ch_crew", ["existing-agent"]);

      const agentDir = path.join(agentsDir, "new-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: New\n", "utf-8");

      manager.setupChannelsForNewAgent("new-agent");

      const members = readMembers(channelsDir, "ch_crew");
      expect(members).toContain("existing-agent");
      expect(members).toContain("new-agent");
      expect(getChannelMemberRoles(path.join(channelsDir, "ch_crew.md"))).toEqual({
        "existing-agent": "project_manager",
        "new-agent": "admin",
      });
    });

    it("does NOT create DM channels (DM is separate system now)", () => {
      const existingDir = path.join(agentsDir, "alice");
      fs.mkdirSync(existingDir, { recursive: true });
      fs.writeFileSync(path.join(existingDir, "config.yaml"), "agent:\n  name: Alice\n", "utf-8");
      fs.writeFileSync(path.join(existingDir, "channels.md"), "", "utf-8");

      const newDir = path.join(agentsDir, "bob");
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(path.join(newDir, "config.yaml"), "agent:\n  name: Bob\n", "utf-8");

      manager.setupChannelsForNewAgent("bob");

      // No DM channel files should exist
      const files = fs.readdirSync(channelsDir);
      const dmFiles = files.filter(f => !f.startsWith("ch_"));
      expect(dmFiles).toHaveLength(0);
    });

    it("writes channels.md for new agent with ch_crew", () => {
      const agentDir = path.join(agentsDir, "new-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: New\n", "utf-8");

      manager.setupChannelsForNewAgent("new-agent");

      const channelsMd = fs.readFileSync(path.join(agentDir, "channels.md"), "utf-8");
      expect(channelsMd).toContain("ch_crew");
    });
  });

  describe("cleanupAgentFromChannels", () => {
    it("removes agent from channel members", () => {
      writeChannelMd(channelsDir, "crew", ["alice", "bob", "charlie"]);

      manager.cleanupAgentFromChannels("bob");

      const members = readMembers(channelsDir, "crew");
      expect(members).toContain("alice");
      expect(members).toContain("charlie");
      expect(members).not.toContain("bob");
    });

    it("keeps at least one project manager after removing the old one", () => {
      fs.writeFileSync(
        path.join(channelsDir, "crew.md"),
        [
          "---",
          "members: [alice, bob, charlie]",
          "member_roles: [alice=project_manager, bob=admin, charlie=worker]",
          "---",
          "",
        ].join("\n"),
        "utf-8",
      );

      manager.cleanupAgentFromChannels("alice");

      expect(getChannelMemberRoles(path.join(channelsDir, "crew.md"))).toEqual({
        bob: "project_manager",
        charlie: "worker",
      });
    });

    it("deletes channel when members drop to 1 or fewer", () => {
      writeChannelMd(channelsDir, "alice-bob", ["alice", "bob"]);

      manager.cleanupAgentFromChannels("bob");

      // DM channel should be deleted (only alice left)
      expect(fs.existsSync(path.join(channelsDir, "alice-bob.md"))).toBe(false);
    });

    it("no-ops when channelsDir does not exist", () => {
      const badManager = new ChannelManager({
        channelsDir: "/nonexistent",
        agentsDir,
        userDir,
        getHub: () => null,
      });

      expect(() => badManager.cleanupAgentFromChannels("x")).not.toThrow();
    });
  });

  describe("group role helpers", () => {
    it("can add an agent to a channel with a role and bookmark", () => {
      writeChannelMd(channelsDir, "build-team", ["pm-1", "admin-1"]);
      fs.writeFileSync(
        path.join(channelsDir, "build-team.md"),
        [
          "---",
          "members: [pm-1, admin-1]",
          "member_roles: [pm-1=project_manager, admin-1=admin]",
          "---",
          "",
        ].join("\n"),
        "utf-8",
      );

      const agentDir = path.join(agentsDir, "worker-1");
      fs.mkdirSync(agentDir, { recursive: true });

      const roles = manager.addAgentToChannel("build-team", "worker-1", "worker");

      expect(roles).toEqual({
        "pm-1": "project_manager",
        "admin-1": "admin",
        "worker-1": "worker",
      });
      expect(fs.readFileSync(path.join(agentDir, "channels.md"), "utf-8")).toContain("build-team");
    });

    it("can update a member role", () => {
      fs.writeFileSync(
        path.join(channelsDir, "ops-team.md"),
        [
          "---",
          "members: [pm-1, admin-1, worker-1]",
          "member_roles: [pm-1=project_manager, admin-1=admin, worker-1=worker]",
          "---",
          "",
        ].join("\n"),
        "utf-8",
      );

      const roles = manager.updateChannelMemberRole("ops-team", "worker-1", "admin");

      expect(roles).toEqual({
        "pm-1": "project_manager",
        "admin-1": "admin",
        "worker-1": "admin",
      });
    });
  });
});
