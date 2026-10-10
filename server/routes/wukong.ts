import { Hono } from "hono";
import { routeError, strictJson } from "../hono-helpers.ts";
import {
  buildWukongSessionKey,
  createWukongCompatibilityManifest,
  normalizeWukongTaskInput,
} from "../../lib/wukong/compat.ts";
import {
  executeWukongAgentRuntimeTask,
  normalizeWukongRuntimeTaskInput,
} from "../../lib/wukong/runtime-adapter.ts";

function resolveTargetAgent(engine: any, c: any, body: Record<string, unknown> = {}) {
  const agentId = typeof c.req.query("agentId") === "string" && c.req.query("agentId").trim()
    ? c.req.query("agentId").trim()
    : typeof body.agentId === "string" && body.agentId.trim()
      ? body.agentId.trim()
      : engine.currentAgentId;
  const agent = agentId ? engine.getAgent?.(agentId) : null;
  if (!agent) {
    const err = new Error(`agent "${agentId || "(missing)"}" not found`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return agent;
}

function resolveBridgeExecutor(engine: any) {
  const manager = engine.bridgeSessionManager;
  if (typeof manager?.executeExternalMessage === "function") {
    return manager.executeExternalMessage.bind(manager);
  }
  if (typeof engine.executeExternalMessage === "function") {
    return engine.executeExternalMessage.bind(engine);
  }
  const err = new Error("bridge session execution is unavailable") as Error & { status?: number };
  err.status = 503;
  throw err;
}

function normalizeResult(result: any) {
  if (typeof result === "string" || result == null) return { text: result || "" };
  return result;
}

export function createWukongRoute(engine: any) {
  const route = new Hono();

  route.get("/wukong/capabilities", async (c) => {
    return c.json(createWukongCompatibilityManifest());
  });

  route.post("/wukong/tasks/run", async (c) => {
    try {
      const body = await strictJson(c);
      const agent = resolveTargetAgent(engine, c, body);
      const task = normalizeWukongTaskInput(body);
      const sessionKey = buildWukongSessionKey({
        agentId: agent.id,
        userId: task.userId,
        conversationId: task.conversationId,
      });
      const executeExternalMessage = resolveBridgeExecutor(engine);
      const result = await executeExternalMessage(
        task.text,
        sessionKey,
        {
          platform: "wukong",
          userId: task.userId,
          chatId: task.conversationId || task.userId,
          senderName: task.userName,
        },
        {
          agentId: agent.id,
          guest: task.guest,
          forceLocalRuntime: true,
          contextTag: "Wukong external-runtime gateway request. Keep platform actions text-command compatible.",
        },
      );
      if (result?.__bridgeError) {
        return c.json({ ok: false, platform: "wukong", agentId: agent.id, sessionKey, error: result.message }, 500);
      }
      return c.json({
        ok: true,
        direction: "inbound_to_codia",
        platform: "wukong",
        agentId: agent.id,
        sessionKey,
        result: normalizeResult(result),
      });
    } catch (err) {
      return routeError(c, err, 500);
    }
  });

  route.post("/wukong/runtime/tasks/run", async (c) => {
    try {
      const body = await strictJson(c);
      const agent = resolveTargetAgent(engine, c, body);
      const task = normalizeWukongRuntimeTaskInput(body);
      const result = await executeWukongAgentRuntimeTask({
        agent,
        engine,
        text: task.text,
        source: {
          subsystem: "codia",
          surface: "api",
          ...(task.source || {}),
        },
        conversation: task.conversation,
        metadata: task.metadata,
        attachments: task.attachments,
      });
      if (!result) {
        return c.json({ ok: false, error: "agent is not configured for Wukong runtime" }, 409);
      }
      return c.json({
        ok: true,
        direction: "codia_to_wukong",
        platform: "wukong",
        agentId: agent.id,
        result,
      });
    } catch (err) {
      return routeError(c, err, 500);
    }
  });

  return route;
}
