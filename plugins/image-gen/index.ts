// @ts-nocheck
// plugins/image-gen/index.js
import path from "node:path";
import fs from "node:fs";
import { AdapterRegistry } from "./lib/adapter-registry.ts";
import { TaskStore } from "./lib/task-store.ts";
import { Poller } from "./lib/poller.ts";
import { submitImageGeneration } from "./lib/submit-image.ts";
import { normalizeSessionRef, retryMediaTask } from "./lib/image-task-runner.ts";
import { execute as executeGenerateVideo } from "./tools/generate-video.ts";
import { volcengineImageAdapter } from "./adapters/volcengine.ts";
import { openaiImageAdapter } from "./adapters/openai.ts";
import { openaiCodexImageAdapter } from "./adapters/openai-codex.ts";
import { minimaxImageAdapter } from "./adapters/minimax.ts";
import { dashscopeImageAdapter } from "./adapters/dashscope.ts";
import { geminiImageAdapter } from "./adapters/gemini.ts";
import { openaiCompatibleImageAdapter } from "./adapters/openai-compatible.ts";
import { openaiCompatibleMediaAdapter } from "./adapters/openai-compatible-media.ts";
import { comfyuiAdapter } from "./adapters/comfyui.ts";
import { minimaxMediaAdapter } from "./adapters/minimax-media.ts";
import { volcengineVideoAdapter } from "./adapters/volcengine-video.ts";
import { agnesImageAdapter, agnesVideoAdapter } from "./adapters/agnes.ts";

const minimaxUnifiedAdapter = {
  ...minimaxMediaAdapter,
  protocolId: minimaxImageAdapter.protocolId,
  protocolIds: minimaxImageAdapter.protocolIds,
  name: "MiniMax Media",
  types: [...new Set([...(minimaxImageAdapter.types || []), ...(minimaxMediaAdapter.types || [])])],
  capabilities: {
    ...(minimaxMediaAdapter.capabilities || {}),
    image: minimaxImageAdapter.capabilities,
  },
  async checkAuth(ctx) {
    return minimaxMediaAdapter.checkAuth?.(ctx) || minimaxImageAdapter.checkAuth?.(ctx) || { ok: true };
  },
  async submit(params, ctx) {
    if ((params?.type || "image") === "image") return minimaxImageAdapter.submit(params, ctx);
    return minimaxMediaAdapter.submit(params, ctx);
  },
  async query(taskId, ctx) {
    return minimaxMediaAdapter.query(taskId, ctx);
  },
};

export default class ImageGenPlugin {
  async onload() {
    const { dataDir, bus, log } = this.ctx;

    const generatedDir = path.join(dataDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });

    // Infrastructure
    const registry = new AdapterRegistry();
    const store = new TaskStore(dataDir);
    const poller = new Poller({
      store,
      registry,
      bus,
      dataDir,
      generatedDir,
      log,
      registerSessionFile: this.ctx.registerSessionFile,
    });

    // Built-in adapters
    registry.register(volcengineImageAdapter);
    registry.register(openaiImageAdapter);
    registry.register(openaiCodexImageAdapter);
    registry.register(dashscopeImageAdapter);
    registry.register(geminiImageAdapter);
    registry.register(openaiCompatibleImageAdapter);
    registry.register(openaiCompatibleMediaAdapter);
    registry.register(comfyuiAdapter);
    registry.register(minimaxUnifiedAdapter);
    registry.register(volcengineVideoAdapter);
    registry.register(agnesImageAdapter);
    registry.register(agnesVideoAdapter);

    if (!this.ctx.config) {
      this.ctx.config = {
        get(key) {
          if (key === "defaultImageModel") return { provider: openaiImageAdapter.id, id: "gpt-image-1" };
          if (key === "providerDefaults") return {};
          return undefined;
        },
      };
    }

    // Attach to ctx for tools
    this.ctx._mediaGen = { registry, store, poller, generatedDir };

 // Bus handlers -adapter registration (for external plugins like dreamina)
    this.register(bus.handle("media-gen:register-adapter", ({ adapter }) => {
      registry.register(adapter);
      log.info(`adapter registered: ${adapter.id}`);
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:unregister-adapter", ({ adapterId }) => {
      registry.unregister(adapterId);
      log.info(`adapter unregistered: ${adapterId}`);
      return { ok: true };
    }));

    // Listen for fire-and-forget unregister events (plugin teardown is sync)
    this.register(bus.subscribe((event) => {
      if (event.type === "media-gen:adapter-removed" && event.adapterId) {
        registry.unregister(event.adapterId);
        log.info(`adapter removed (event): ${event.adapterId}`);
      }
    }));

    this.register(bus.handle("media-gen:list-adapters", () => {
      return { adapters: registry.list().map((a) => ({ id: a.id, name: a.name, types: a.types })) };
    }));

    this.register(bus.handle("media:generate-image", async (payload = {}) => {
      return bus.request("media-gen:submit-image", payload);
    }));

    this.register(bus.handle("media:generate-video", async (payload = {}) => {
      return bus.request("media-gen:submit-video", payload);
    }));

    this.register(bus.handle("media:generate", async (payload = {}) => {
      const kind = String(payload.kind || payload.type || "image").toLowerCase();
      if (kind === "video") return bus.request("media-gen:submit-video", payload);
      if (kind === "image") return bus.request("media-gen:submit-image", payload);
      return { ok: false, error: `unsupported media kind: ${kind}` };
    }));

 // Bus handlers -task CRUD (for external panels like dreamina)
    this.register(bus.handle("media-gen:submit-image", async (payload = {}) => {
      const input = payload.input && typeof payload.input === "object"
        ? {
          ...payload.input,
          ...(payload.delivery !== undefined ? { delivery: payload.delivery } : {}),
          ...(payload.deliveryMode !== undefined ? { deliveryMode: payload.deliveryMode } : {}),
        }
        : payload;
      const sessionTarget = normalizeSessionRef(payload);
      const { sessionId, sessionPath, sessionRef } = sessionTarget;
      const delivery = input?.delivery && typeof input.delivery === "object" ? input.delivery : {};
      const deliveryMode = String(delivery.mode || input?.deliveryMode || "").toLowerCase();
      if (!sessionId && !sessionPath && deliveryMode !== "response") {
        return { ok: false, error: "sessionId or sessionPath is required" };
      }
      try {
        return await submitImageGeneration({
          input,
          ctx: {
            ...this.ctx,
            sessionId,
            sessionPath,
            sessionRef,
            _mediaGen: this.ctx._mediaGen,
          },
          metadata: payload.metadata || null,
          deliveryTarget: payload.deliveryTarget === undefined ? null : payload.deliveryTarget,
        });
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }));

    this.register(bus.handle("media-gen:submit-video", async (payload = {}) => {
      const input = payload.input && typeof payload.input === "object"
        ? {
          ...payload.input,
          ...(payload.delivery !== undefined ? { delivery: payload.delivery } : {}),
          ...(payload.deliveryMode !== undefined ? { deliveryMode: payload.deliveryMode } : {}),
        }
        : payload;
      const sessionTarget = normalizeSessionRef(payload);
      const { sessionId, sessionPath, sessionRef } = sessionTarget;
      const delivery = input?.delivery && typeof input.delivery === "object" ? input.delivery : {};
      const deliveryMode = String(delivery.mode || input?.deliveryMode || "").toLowerCase();
      if (!sessionId && !sessionPath && deliveryMode !== "response") {
        return { ok: false, error: "sessionId or sessionPath is required" };
      }
      try {
        const result = await executeGenerateVideo(input, {
          ...this.ctx,
          sessionId,
          sessionPath,
          sessionRef,
          _mediaGen: this.ctx._mediaGen,
        });
        if (result?.details?.error) {
          return {
            ok: false,
            error: result.details.error.message || result.details.error.code || "video generation failed",
            content: result.content || [],
            details: result.details,
          };
        }
        return {
          ok: true,
          content: result?.content || [],
          details: result?.details || {},
        };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }));

    this.register(bus.handle("media-gen:get-tasks", ({ adapterId, batchId, status } = {}) => {
      let tasks = store.listAll();
      if (adapterId) tasks = tasks.filter((t) => t.adapterId === adapterId);
      if (batchId) tasks = tasks.filter((t) => t.batchId === batchId);
      if (status) tasks = tasks.filter((t) => t.status === status);
      return { tasks };
    }));

    this.register(bus.handle("media-gen:get-task", ({ taskId }) => {
      return { task: store.get(taskId) };
    }));

    this.register(bus.handle("media-gen:update-task", ({ taskId, fields }) => {
      const allowed = {};
      if (typeof fields?.favorited === "boolean") allowed.favorited = fields.favorited;
      store.update(taskId, allowed);
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:remove-task", ({ taskId }) => {
      const task = store.get(taskId);
      if (task) {
        for (const f of task.files || []) {
          try { fs.unlinkSync(path.join(generatedDir, f)); } catch { /* ok */ }
        }
        store.remove(taskId);
      }
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:remove-unfavorited", () => {
      const removed = store.removeUnfavorited();
      for (const t of removed) {
        for (const f of t.files || []) {
          try { fs.unlinkSync(path.join(generatedDir, f)); } catch { /* ok */ }
        }
      }
      return { ok: true, removed: removed.length };
    }));

    // Start poller
    poller.start();

    // Register media-generation task handler for TaskRegistry
    bus.request("task:register-handler", {
      type: "media-generation",
      abort: (taskId) => { poller.cancel(taskId); },
      retry: (taskId) => retryMediaTask({ taskId, ctx: this.ctx }),
    }).catch(() => {});

    // Cleanup
    this.register(() => {
      poller.stop();
      store.destroy();
      bus.request("task:unregister-handler", { type: "media-generation" }).catch(() => {});
      log.info("image-gen plugin unloaded");
    });

    log.info("image-gen plugin loaded (unified media-gen)");
  }
}
