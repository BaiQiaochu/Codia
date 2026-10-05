import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import mediaRoute from "../plugins/image-gen/routes/media.ts";

describe("image-gen provider discovery", () => {
  it("uses provider media capabilities instead of a hardcoded image provider catalog", async () => {
    const app = new Hono();
    mediaRoute(app, {
      dataDir: "/tmp/hana-image-gen-test",
      config: { get: () => ({}) },
      _mediaGen: {
        registry: {
          getProtocol: (protocolId) => protocolId === "plugin-images" ? { id: "plugin-adapter" } : null,
          get: () => null,
        },
      },
      bus: {
        async request(type) {
          if (type === "provider:media-providers") {
            return {
              providers: {
                "plugin-image": {
                  providerId: "plugin-image",
                  displayName: "Plugin Image",
                  hasCredentials: true,
                  runtime: { kind: "local-cli" },
                  models: [{ id: "plugin-model", name: "Plugin Model", protocolId: "plugin-images" }],
                  availableModels: [],
                },
              },
            };
          }
          throw new Error(`unexpected bus request: ${type}`);
        },
      },
    });

    const res = await app.request("/providers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.providers)).toEqual(["plugin-image"]);
    expect(body.providers["plugin-image"]).toMatchObject({
      displayName: "Plugin Image",
      models: [{ id: "plugin-model", name: "Plugin Model", adapterAvailable: true }],
    });
  });

  it("filters media models without a registered protocol adapter from selectable provider lists", async () => {
    const app = new Hono();
    mediaRoute(app, {
      dataDir: "/tmp/hana-image-gen-test",
      config: { get: () => ({}) },
      _mediaGen: {
        registry: {
          getProtocol: () => null,
          get: () => null,
        },
      },
      bus: {
        async request(type) {
          if (type === "provider:media-providers") {
            return {
              providers: {
                axis: {
                  providerId: "axis",
                  displayName: "Axis",
                  hasCredentials: true,
                  models: [{ id: "gpt-image-2", name: "GPT Image 2", protocolId: "axis-images" }],
                  availableModels: [],
                },
              },
            };
          }
          throw new Error(`unexpected bus request: ${type}`);
        },
      },
    });

    const res = await app.request("/providers");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toEqual({});
  });

  it("keeps custom provider models whose inferred protocol has a registered adapter", async () => {
    const app = new Hono();
    mediaRoute(app, {
      dataDir: "/tmp/gsap-image-gen-test",
      config: { get: () => ({}) },
      _mediaGen: {
        registry: {
          getProtocol: (protocolId) => protocolId === "openai-images" ? { id: "openai-images" } : null,
          get: () => null,
        },
      },
      bus: {
        async request(type) {
          if (type === "provider:media-providers") {
            return {
              providers: {
                "my-proxy": {
                  providerId: "my-proxy",
                  displayName: "My Proxy",
                  hasCredentials: true,
                  models: [{ id: "flux-1.1-pro", name: "FLUX 1.1 Pro", protocolId: "openai-images" }],
                  availableModels: [],
                },
              },
            };
          }
          throw new Error(`unexpected bus request: ${type}`);
        },
      },
    });

    const res = await app.request("/providers");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers["my-proxy"]).toMatchObject({
      displayName: "My Proxy",
      models: [{ id: "flux-1.1-pro", name: "FLUX 1.1 Pro", protocolId: "openai-images", adapterAvailable: true }],
    });
  });

  it("logs a diagnostic instead of silently dropping models without a recognized protocol", async () => {
    const warn: string[] = [];
    const app = new Hono();
    mediaRoute(app, {
      dataDir: "/tmp/gsap-image-gen-test",
      config: { get: () => ({}) },
      log: { warn: (...args) => warn.push(args.join(" ")) },
      _mediaGen: {
        registry: {
          getProtocol: () => null,
          get: () => null,
        },
      },
      bus: {
        async request(type) {
          if (type === "provider:media-providers") {
            return {
              providers: {
                "my-anthropic-proxy": {
                  providerId: "my-anthropic-proxy",
                  displayName: "My Anthropic Proxy",
                  hasCredentials: true,
                  models: [{ id: "claude-image-x", name: "Claude Image X" }],
                  availableModels: [],
                },
              },
            };
          }
          throw new Error(`unexpected bus request: ${type}`);
        },
      },
    });

    const res = await app.request("/providers");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toEqual({});
    expect(warn.some((line) => line.includes("my-anthropic-proxy/claude-image-x"))).toBe(true);
  });

  it("adds and removes image models through media provider bus handlers", async () => {
    const calls = [];
    const app = new Hono();
    mediaRoute(app, {
      dataDir: "/tmp/hana-image-gen-test",
      config: { get: () => ({}) },
      bus: {
        async request(type, payload) {
          calls.push([type, payload]);
          return { ok: true };
        },
      },
    });

    const addRes = await app.request("/providers/dashscope/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { id: "wan2.7-image-pro", protocolId: "dashscope-images" } }),
    });
    expect(addRes.status).toBe(200);

    const deleteRes = await app.request("/providers/dashscope/models/wan2.7-image-pro", {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    expect(calls).toEqual([
      ["provider:add-media-model", {
        providerId: "dashscope",
        capability: "image_generation",
        model: { id: "wan2.7-image-pro", protocolId: "dashscope-images" },
      }],
      ["provider:remove-media-model", {
        providerId: "dashscope",
        capability: "image_generation",
        modelId: "wan2.7-image-pro",
      }],
    ]);
  });
});
