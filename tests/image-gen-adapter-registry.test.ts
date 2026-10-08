import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../plugins/image-gen/lib/adapter-registry.ts";

describe("image-gen AdapterRegistry", () => {
  it("resolves adapters by protocolId and compatibility aliases", () => {
    const registry = new AdapterRegistry();
    const adapter = {
      id: "openai",
      protocolId: "openai-images",
      aliases: ["openai-compat"],
      types: ["image"],
    };

    registry.register(adapter);

    expect(registry.get("openai")).toBe(adapter);
    expect(registry.get("openai-compat")).toBe(adapter);
    expect(registry.getProtocol("openai-images")).toBe(adapter);
  });

  it("removes protocol and aliases when an adapter is unregistered", () => {
    const registry = new AdapterRegistry();
    const adapter = {
      id: "gemini",
      protocolIds: ["gemini-generate-content-image"],
      aliases: ["google-gemini"],
      types: ["image"],
    };

    registry.register(adapter);
    registry.unregister("gemini");

    expect(registry.get("gemini")).toBeNull();
    expect(registry.get("google-gemini")).toBeNull();
    expect(registry.getProtocol("gemini-generate-content-image")).toBeNull();
  });

  it("does not return duplicate adapters through list or typed queries when aliases are registered", () => {
    const registry = new AdapterRegistry();
    const adapter = {
      id: "dashscope",
      protocolId: "dashscope-wan-images",
      aliases: ["dashscope-images"],
      types: ["image"],
    };

    registry.register(adapter);

    expect(registry.list()).toEqual([adapter]);
    expect(registry.getByType("image")).toEqual([adapter]);
  });
});
