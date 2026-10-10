// @ts-nocheck
import { Hono } from "hono";
import { createServerRuntimeContext, toServerIdentityResponse } from "../../core/server-runtime-context.ts";

export function createServerIdentityRoute({
  codiaHome,
  appVersion = "?",
  getRuntimeContext,
}: {
  codiaHome?: string;
  appVersion?: string;
  getRuntimeContext?: () => unknown;
} = {}) {
  const route = new Hono();

  route.get("/server/identity", (c) => {
    try {
      const runtimeContext = typeof getRuntimeContext === "function"
        ? getRuntimeContext()
        : createServerRuntimeContext({ codiaHome, appVersion });
      return c.json(toServerIdentityResponse(runtimeContext, { appVersion }));
    } catch (err: any) {
      return c.json({
        error: "invalid server identity registry",
        detail: err.message,
      }, 500);
    }
  });

  return route;
}
