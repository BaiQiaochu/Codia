import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDmRoute } from "../server/routes/dm.js";
import { appendMessage } from "../lib/channels/channel-store.js";

function makeAgent(root, id, name = id) {
  const agentDir = path.join(root, "agents", id);
  fs.mkdirSync(path.join(agentDir, "dm"), { recursive: true });
  return { id, name, agentName: name, agentDir };
}

async function writeDm(agent, peerId, sender, body) {
  const filePath = path.join(agent.agentDir, "dm", `${peerId}.md`);
  await appendMessage(filePath, sender, body);
}

describe("dm route phone gate", () => {
  let tmpDir;
  let app;
  let agents;
  let channelsEnabled;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-dm-route-"));
    channelsEnabled = true;
    agents = new Map([
      ["alice", makeAgent(tmpDir, "alice", "Alice")],
      ["bob", makeAgent(tmpDir, "bob", "Bob")],
    ]);
    await writeDm(agents.get("alice"), "bob", "bob", "primary-owned thread");

    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      currentAgentId: "alice",
      getPrimaryAgentId: () => "alice",
      getAgent: (id) => agents.get(id) || null,
      listAgents: () => Array.from(agents.values()),
      isChannelsEnabled: () => channelsEnabled,
    };

    app = new Hono();
    app.route("/api", createDmRoute(engine));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("freezes DM routes when the phone feature is disabled", async () => {
    channelsEnabled = false;

    const listRes = await app.request("/api/dm");
    expect(listRes.status).toBe(503);
    expect((await listRes.json()).error).toMatch(/disabled/i);

    const detailRes = await app.request("/api/dm/bob");
    expect(detailRes.status).toBe(503);
    expect((await detailRes.json()).error).toMatch(/disabled/i);
  });

  it("returns an empty DM thread when no history file exists", async () => {
    const res = await app.request("/api/dm/alice?agentId=bob");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ownerAgentId: "bob",
      peerId: "alice",
      peerName: "Alice",
      messages: [],
    });
  });
});
