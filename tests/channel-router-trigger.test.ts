// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannel } from "../lib/channels/channel-store.js";
import { ChannelRouter } from "../hub/channel-router.js";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channel-router-trigger-"));
}

describe("ChannelRouter trigger lifecycle", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("passes channel mentions from agent posts into immediate delivery", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const [agentId, name] of [["nova", "Nova"], ["yui", "Yui Ray"]]) {
      fs.mkdirSync(path.join(agentsDir, agentId), { recursive: true });
      fs.writeFileSync(path.join(agentsDir, agentId, "config.yaml"), `agent:\n  name: ${name}\n`, "utf-8");
      fs.writeFileSync(path.join(agentsDir, agentId, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: channelId } = createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["nova", "yui"],
    });

    let onPost;
    const postAgent = {
      setChannelPostHandler: (handler) => { onPost = handler; },
    };
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          agents: new Map([["nova", postAgent]]),
          listAgents: () => [
            { id: "nova", name: "Nova" },
            { id: "yui", name: "Yui Ray" },
          ],
          isChannelsEnabled: () => true,
        },
        eventBus: { emit: vi.fn() },
      },
    });
    const triggerImmediate = vi.spyOn(router, "triggerImmediate").mockResolvedValue();

    router.setupPostHandler();
    onPost(channelId, "nova", { sender: "nova", body: "@Yui Ray please check this" });

    expect(triggerImmediate).toHaveBeenCalledWith(channelId, {
      mentionedAgents: ["yui"],
      triggerSource: "agent_post",
      sourceAgentId: "nova",
    });
  });

  it("does not fan out ordinary agent posts without explicit channel mentions", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const [agentId, name] of [["nova", "Nova"], ["yui", "Yui Ray"]]) {
      fs.mkdirSync(path.join(agentsDir, agentId), { recursive: true });
      fs.writeFileSync(path.join(agentsDir, agentId, "config.yaml"), `agent:\n  name: ${name}\n`, "utf-8");
      fs.writeFileSync(path.join(agentsDir, agentId, "channels.md"), "# Channels\n\n", "utf-8");
    }

    const { id: channelId } = createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["nova", "yui"],
    });

    let onPost;
    const postAgent = {
      setChannelPostHandler: (handler) => { onPost = handler; },
    };
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          agents: new Map([["nova", postAgent]]),
          listAgents: () => [
            { id: "nova", name: "Nova" },
            { id: "yui", name: "Yui Ray" },
          ],
          isChannelsEnabled: () => true,
        },
        eventBus: { emit: vi.fn() },
      },
    });
    const triggerImmediate = vi.spyOn(router, "triggerImmediate").mockResolvedValue();

    router.setupPostHandler();
    onPost(channelId, "nova", { sender: "nova", body: "收到，频道静默" });

    expect(triggerImmediate).not.toHaveBeenCalled();
  });

  it("uses agent config files as channel delivery candidates without requiring cursor projections", () => {
    tmpDir = mktemp();
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["nova", "yui"]) {
      fs.mkdirSync(path.join(agentsDir, agentId), { recursive: true });
      fs.writeFileSync(path.join(agentsDir, agentId, "config.yaml"), `agent:\n  name: ${agentId}\n`, "utf-8");
    }

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir,
          channelsDir: path.join(tmpDir, "channels"),
          agents: new Map(),
          canRunBackgroundTask: (agentId) => agentId !== "yui",
        },
        eventBus: { emit: vi.fn() },
      },
    });

    expect(router.getAgentOrder()).toEqual(["nova"]);
  });
});
