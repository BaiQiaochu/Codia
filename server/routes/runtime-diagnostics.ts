import { Hono } from "hono";

export function createRuntimeDiagnosticsRoute(service) {
  const route = new Hono();

  route.get("/diagnostics/runtime", (c) => {
    return c.json(service.snapshot());
  });

  return route;
}
