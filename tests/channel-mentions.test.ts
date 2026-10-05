import { describe, expect, it } from "vitest";
import { extractMentionedAgentIds } from "../lib/channels/channel-mentions.js";

describe("channel mention extraction", () => {
  it("resolves multi-word display names without also matching a shorter prefix alias", () => {
    const agents = [
      { id: "yui", name: "Yui" },
      { id: "yui-ray", name: "Yui Ray" },
      { id: "nova", name: "Nova" },
    ];

    expect(extractMentionedAgentIds("@Yui Ray please check this", {
      channelMembers: ["yui", "yui-ray", "nova"],
      agents,
    })).toEqual(["yui-ray"]);
  });

  it("does not resolve ambiguous display-name mentions by list order", () => {
    const agents = [
      { id: "nova-a", name: "Nova" },
      { id: "nova-b", name: "Nova" },
    ];

    expect(extractMentionedAgentIds("@Nova check this", {
      channelMembers: ["nova-a", "nova-b"],
      agents,
    })).toEqual([]);
  });
});
